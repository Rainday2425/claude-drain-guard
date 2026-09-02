'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { usageFromEntry, mergeSlice } = require('./metrics');
const { analyzeTurn, bootstrapForecast, transitionAlertState, compact } = require('./detector');
const { Store } = require('./store');
const { generateReport } = require('./report');
const { fetchQuota, quotaDelta, defaultCredentials } = require('./quota');
const { recentJsonl, readJsonlIncrement } = require('./scanner');

let guard;

class DrainGuard {
  constructor(context) {
    this.context = context;
    this.config = this.readConfig();
    this.store = new Store(path.join(context.globalStorageUri.fsPath, 'metrics.json'));
    this.state = this.store.load();
    this.bootstrapping = true;
    this.mutedUntil = 0;
    this.alertState = { level: 'healthy', healthyStreak: 0 };
    this.scanTimer = null;
    this.activeFiles = new Set();
    this.pendingFiles = new Set();
    this.seenIds = new Set(this.state.seen);
    this.scanPromise = null;
    const alignment = this.config.alignment === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right;
    this.status = vscode.window.createStatusBarItem('claudeDrainGuard.usage', alignment, 92);
    this.status.name = 'Claude Drain Guard';
    this.status.command = 'claudeDrainGuard.showDetails';
    this.status.show();
    this.alertStatus = vscode.window.createStatusBarItem('claudeDrainGuard.alert', alignment, 91);
    this.alertStatus.name = 'Claude Drain Guard alert';
    this.alertStatus.command = 'claudeDrainGuard.showDetails';
    context.subscriptions.push(this.status, this.alertStatus);
  }

  readConfig() {
    const c = vscode.workspace.getConfiguration('claudeDrainGuard');
    return {
      dataDirectory: c.get('dataDirectory') || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
      sliceMinutes: c.get('sliceMinutes', 5), cacheMissPercent: c.get('cacheMissPercent', 60),
      cacheCliffPoints: c.get('cacheCliffPoints', 40), largeFreshTokens: c.get('largeFreshTokens', 100000),
      robustZThreshold: c.get('robustZThreshold', 4.5), notifications: c.get('notifications', true),
      modalCriticalAlerts: c.get('modalCriticalAlerts', true), autoGenerateCriticalReport: c.get('autoGenerateCriticalReport', true),
      quotaEnabled: c.get('authoritativeQuota.enabled', false),
      quotaCredentials: c.get('authoritativeQuota.credentialsPath', ''),
      quotaSpikePercent: c.get('authoritativeQuota.sliceSpikePercent', 2) / 100,
      refreshIntervalSeconds: c.get('refreshIntervalSeconds', 15),
      alignment: c.get('statusBarAlignment', 'right')
    };
  }

  start() {
    this.watch();
    this.startTimers();
    this.reconcileFiles().finally(() => {
      this.bootstrapping = false;
      const turn = this.state.turns.at(-1);
      if (turn && this.lastAnalysis) {
        this.lastAnalysis.forecast = bootstrapForecast(this.state.slices.slice(-12).map(slice => slice.fresh));
        this.render(turn, this.lastAnalysis);
      }
    });
  }

  startTimers() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    const seconds = Math.max(1, Math.min(60, Number(this.config.refreshIntervalSeconds) || 15));
    this.refreshTimer = setInterval(() => this.queueScan(this.activeFiles), seconds * 1000);
    if (!this.discoveryTimer) this.discoveryTimer = setInterval(() => { this.reconcileFiles().catch(() => {}); }, 60_000);
    this.context.subscriptions.push({ dispose: () => {
      clearInterval(this.refreshTimer);
      clearInterval(this.discoveryTimer);
      clearTimeout(this.scanTimer);
    } });
  }

  async reconcileFiles() {
    const root = path.join(this.config.dataDirectory, 'projects');
    const discovered = await recentJsonl(root);
    const current = new Set(discovered);
    for (const file of this.activeFiles) if (!current.has(file)) this.activeFiles.delete(file);
    for (const file of current) this.activeFiles.add(file);
    if (discovered.length) await this.queueScan(discovered);
  }

  watch() {
    const projects = path.join(this.config.dataDirectory, 'projects');
    if (!fs.existsSync(projects)) { this.render(null, { risk: 'idle', alerts: [] }); return; }
    try {
      const watcher = fs.watch(projects, { recursive: true }, (_event, file) => {
        if (!file || !String(file).endsWith('.jsonl')) return;
        const changed = path.resolve(projects, String(file));
        this.activeFiles.add(changed);
        clearTimeout(this.scanTimer);
        this.scanTimer = setTimeout(() => this.queueScan([changed]), 200);
      });
      this.context.subscriptions.push({ dispose: () => watcher.close() });
    } catch { /* periodic known-file scan remains active */ }
  }

  queueScan(files) {
    for (const file of files || []) this.pendingFiles.add(file);
    if (!this.scanPromise) {
      this.scanPromise = this.drainScans().finally(() => { this.scanPromise = null; });
    }
    return this.scanPromise;
  }

  async drainScans() {
    let totalChanges = 0, offsetsChanged = false;
    while (this.pendingFiles.size) {
      const files = [...this.pendingFiles];
      this.pendingFiles.clear();
      for (const file of files) {
        const result = await this.readIncrement(file);
        totalChanges += result.processed;
        offsetsChanged ||= result.offsetChanged;
      }
    }
    if (offsetsChanged) this.store.scheduleSave();
    if (totalChanges > 0 && !this.bootstrapping) this.refreshQuota();
    return totalChanges;
  }

  async readIncrement(file) {
    const previousOffset = this.state.offsets[file] || 0;
    const result = await readJsonlIncrement(file, previousOffset, entry => this.processEntry(entry, file));
    if (result.missing) this.activeFiles.delete(file);
    else this.state.offsets[file] = result.offset;
    return { processed: result.processed, offsetChanged: result.offset !== previousOffset };
  }

  processEntry(entry, file) {
    const turn = usageFromEntry(entry);
    if (!turn || (turn.id && this.seenIds.has(turn.id))) return 0;
    this.processTurn(turn, file);
    if (turn.id) {
      this.seenIds.add(turn.id);
      if (this.seenIds.size > 1200) this.seenIds = new Set(this.state.seen);
    }
    return 1;
  }

  processTurn(turn, file) {
    turn.project = projectFromPath(file, path.join(this.config.dataDirectory, 'projects'));
    turn.contextBucket = `${Math.floor(turn.totalInput / 50_000) * 50}k`;
    turn.cacheState = turn.cacheHit < this.config.cacheMissPercent ? 'miss' : 'warm';
    turn.groupKey = `${turn.model}|${turn.project}|${turn.contextBucket}|${turn.cacheState}`;
    const group = this.state.groups[turn.groupKey] || { turns: [], online: {} };
    const previous = group.turns.at(-1);
    const analysis = analyzeTurn(turn, previous, group.turns, this.config, group.online);
    turn.risk = analysis.risk;
    turn.alerts = analysis.alerts;
    turn.riskScore = analysis.score;
    turn.signals = analysis.signals;
    group.online = analysis.online;
    group.turns.push(turn);
    group.turns = group.turns.slice(-144);
    this.state.groups[turn.groupKey] = group;
    this.store.addTurn(turn);
    const current = this.state.slices.at(-1);
    this.store.addSlice(mergeSlice(current, turn, this.config.sliceMinutes));
    this.alertState = transitionAlertState(this.alertState, analysis.risk, turn.timestamp);
    analysis.displayRisk = this.alertState.level;
    this.lastAnalysis = analysis;
    if (!this.bootstrapping) {
      analysis.forecast = bootstrapForecast(this.state.slices.slice(-12).map(s => s.fresh));
      this.render(turn, analysis);
      if (analysis.alerts.length && this.alertState.shouldNotify && Date.now() >= this.mutedUntil) this.alert(turn, analysis);
    }
  }

  async refreshQuota() {
    if (!this.config.quotaEnabled || this.quotaPending) return;
    const previous = this.state.quotaSnapshots.at(-1);
    if (previous && Date.now() - previous.timestamp < 5 * 60_000) return;
    this.quotaPending = true;
    try {
      const current = await fetchQuota({ credentialsPath: defaultCredentials(this.config.dataDirectory, this.config.quotaCredentials) });
      const delta = quotaDelta(previous, current);
      current.delta5h = delta;
      this.state.quotaSnapshots.push(current);
      this.state.quotaSnapshots = this.state.quotaSnapshots.slice(-288);
      this.store.scheduleSave();
      const turn = this.state.turns.at(-1);
      if (turn && delta !== null) {
        turn.quota5h = current.utilization5h;
        turn.quotaDelta5h = delta;
        if (delta >= this.config.quotaSpikePercent) {
          const evidence = { severity: 'critical', code: 'QUOTA_SPIKE', text: `5m quota jumped ${(delta * 100).toFixed(1)} points` };
          turn.alerts = [...(turn.alerts || []), evidence];
          turn.risk = 'critical'; turn.riskScore = 100;
          const analysis = { ...(this.lastAnalysis || {}), alerts: turn.alerts, risk: 'critical', displayRisk: 'critical', score: 100 };
          this.render(turn, analysis);
          if (Date.now() >= this.mutedUntil) this.alert(turn, analysis);
        } else if (this.lastAnalysis) this.render(turn, this.lastAnalysis);
      }
    } catch (error) {
      this.quotaError = error instanceof Error ? error.message : String(error);
    } finally { this.quotaPending = false; }
  }

  render(turn, analysis) {
    if (!turn) {
      this.status.text = '5h —';
      this.status.tooltip = `Claude Drain Guard\nWaiting for Claude Code activity.`;
      this.status.backgroundColor = undefined;
      this.alertStatus.text = '$(circle-filled)';
      this.alertStatus.color = new vscode.ThemeColor('charts.blue');
      this.alertStatus.tooltip = this.status.tooltip;
      this.alertStatus.show();
      return;
    }
    const risk = analysis.displayRisk || analysis.risk;
    const quota = this.state.quotaSnapshots.at(-1);
    const quotaPart = quota ? `5h ${(quota.utilization5h * 100).toFixed(0)}%` : '5h —';
    this.status.text = `${quotaPart} · cache ${turn.cacheHit.toFixed(0)}%`;
    this.status.backgroundColor = undefined;
    this.status.color = undefined;
    const tooltip = this.tooltip(turn, analysis);
    this.status.tooltip = tooltip;
    this.alertStatus.tooltip = tooltip;
    this.alertStatus.backgroundColor = undefined;
    if (risk === 'critical') {
      this.alertStatus.text = '$(circle-filled) Alert';
      this.alertStatus.color = new vscode.ThemeColor('charts.red');
      this.alertStatus.show();
    } else if (risk === 'warning') {
      this.alertStatus.text = '$(circle-filled)';
      this.alertStatus.color = new vscode.ThemeColor('charts.yellow');
      this.alertStatus.show();
    } else {
      this.alertStatus.text = '$(circle-filled)';
      this.alertStatus.color = new vscode.ThemeColor('charts.blue');
      this.alertStatus.show();
    }
  }

  tooltip(turn, analysis) {
    const slice = this.state.slices.at(-1);
    const issues = (analysis.alerts || []).map(a => a.text).join(' · ') || 'No anomaly detected';
    const quota = this.state.quotaSnapshots.at(-1);
    const risk = analysis.displayRisk || analysis.risk;
    const heading = risk === 'critical' ? 'Critical drain risk' : risk === 'warning' ? 'Elevated usage' : 'Normal';
    const quotaRow = quota ? `${(quota.utilization5h * 100).toFixed(1)}%${quota.delta5h === null || quota.delta5h === undefined ? '' : ` (+${(quota.delta5h * 100).toFixed(1)} pts / 5m)`}` : this.config.quotaEnabled ? 'Unavailable' : 'Off';
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.appendMarkdown(`**Claude Drain Guard — ${heading}**\n\n`);
    markdown.appendMarkdown(`5h ${quotaRow} · cache ${turn.cacheHit.toFixed(0)}% · fresh ${compact(slice?.fresh || 0)} / 5m\n\n`);
    if (analysis.alerts?.length) markdown.appendMarkdown(`${issues}\n\n`);
    markdown.appendMarkdown(`_${turn.model} · ${turn.project} · click for details and report_`);
    return markdown;
  }

  async alert(turn, analysis) {
    const critical = analysis.risk === 'critical';
    const message = `Claude ${critical ? 'drain' : 'cache'} anomaly: ${analysis.alerts.map(a => a.text).join(' · ')}`;
    let reportPath = null;
    if (critical && this.config.autoGenerateCriticalReport) reportPath = this.writeReport(turn);
    if (!this.config.notifications) return;
    const action = critical
      ? await vscode.window.showErrorMessage(message, { modal: this.config.modalCriticalAlerts, detail: 'Stop before submitting another prompt. The first anomalous turn has been recorded.' }, 'Open incident report', 'Mute 15 min')
      : await vscode.window.showWarningMessage(message, 'Show details', 'Mute 15 min');
    if (action === 'Show details') this.showDetails();
    if (action === 'Open incident report' && reportPath) this.openReport(reportPath);
    if (action === 'Mute 15 min') this.mutedUntil = Date.now() + 15 * 60_000;
  }

  writeReport(incident = this.state.turns.at(-1)) {
    if (!incident) return null;
    const directory = path.join(this.context.globalStorageUri.fsPath, 'reports');
    fs.mkdirSync(directory, { recursive: true });
    const stamp = new Date(incident.timestamp).toISOString().replace(/[:.]/g, '-');
    const file = path.join(directory, `incident-${stamp}.md`);
    fs.writeFileSync(file, generateReport(incident, this.state.turns, this.state.slices, this.config), 'utf8');
    return file;
  }

  async openReport(file = this.writeReport()) {
    if (!file) { vscode.window.showInformationMessage('No Claude usage has been observed yet.'); return; }
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  showDetails() {
    const turns = this.state.turns.slice(-10).reverse();
    const items = turns.map(t => ({
      label: `${t.risk === 'critical' ? '$(error)' : t.risk === 'warning' ? '$(warning)' : '$(pulse)'} ${new Date(t.timestamp).toLocaleTimeString()} · ${t.risk === 'critical' ? 'Critical' : t.risk === 'warning' ? 'Elevated' : 'Normal'}`,
      description: `Cache ${t.cacheHit.toFixed(0)}% · ${compact(t.fresh)} fresh`,
      detail: `${t.model} · risk ${Math.round(t.riskScore || 0)}/100${t.alerts?.length ? ` · ${t.alerts.map(a => a.code).join(', ')}` : ''}`,
      turn: t
    }));
    const actions = [
      { label: `$(clock) Refresh every ${this.config.refreshIntervalSeconds}s`, description: 'Set interval from 1 to 60 seconds', refresh: true },
      { label: '$(file-text) Generate incident report', description: 'Save evidence as Markdown', report: true },
      ...items
    ];
    vscode.window.showQuickPick(actions, { title: 'Claude Drain Guard', placeHolder: 'Recent activity · five-minute slices retained for 24 hours', matchOnDescription: true, matchOnDetail: true }).then(selected => {
      if (selected?.refresh) this.setRefreshInterval();
      if (selected?.report) this.openReport();
    });
  }

  async setRefreshInterval() {
    const value = await vscode.window.showInputBox({
      title: 'Claude Drain Guard refresh interval',
      prompt: 'Enter a whole number from 1 to 60 seconds',
      value: String(this.config.refreshIntervalSeconds),
      validateInput: input => {
        const seconds = Number(input);
        return Number.isInteger(seconds) && seconds >= 1 && seconds <= 60 ? undefined : 'Use a whole number from 1 to 60.';
      }
    });
    if (value === undefined) return;
    const seconds = Number(value);
    await vscode.workspace.getConfiguration('claudeDrainGuard').update('refreshIntervalSeconds', seconds, vscode.ConfigurationTarget.Global);
    this.config.refreshIntervalSeconds = seconds;
    clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => this.queueScan(this.activeFiles), seconds * 1000);
    await this.queueScan(this.activeFiles);
    vscode.window.showInformationMessage(`Claude Drain Guard refreshes every ${seconds}s.`);
  }
}

function projectFromPath(file, projectsRoot) {
  const relative = path.relative(projectsRoot, file);
  return relative.split(path.sep)[0] || 'unknown';
}

function activate(context) {
  guard = new DrainGuard(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeDrainGuard.showDetails', () => guard.showDetails()),
    vscode.commands.registerCommand('claudeDrainGuard.generateReport', () => guard.openReport()),
    vscode.commands.registerCommand('claudeDrainGuard.mute', () => { guard.mutedUntil = Date.now() + 15 * 60_000; }),
    vscode.commands.registerCommand('claudeDrainGuard.resetBaseline', () => { guard.state.turns = []; guard.state.slices = []; guard.store.save(); vscode.window.showInformationMessage('Claude Drain Guard baseline reset.'); })
  );
  guard.start();
}

function deactivate() { return guard?.store.save(); }
module.exports = { activate, deactivate };
