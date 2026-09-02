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
    const alignment = this.config.alignment === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right;
    this.healthStatus = vscode.window.createStatusBarItem('claudeDrainGuard.health', alignment, 92);
    this.quotaStatus = vscode.window.createStatusBarItem('claudeDrainGuard.quota', alignment, 91);
    this.cacheStatus = vscode.window.createStatusBarItem('claudeDrainGuard.cache', alignment, 90);
    this.healthStatus.name = 'Claude Guard: health';
    this.quotaStatus.name = 'Claude Guard: five-hour quota';
    this.cacheStatus.name = 'Claude Guard: prompt cache';
    for (const item of [this.healthStatus, this.quotaStatus, this.cacheStatus]) {
      item.command = 'claudeDrainGuard.showDetails'; item.show(); context.subscriptions.push(item);
    }
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
      alignment: c.get('statusBarAlignment', 'right')
    };
  }

  start() {
    this.watch();
    this.scan();
    this.bootstrapping = false;
  }

  watch() {
    const projects = path.join(this.config.dataDirectory, 'projects');
    if (!fs.existsSync(projects)) { this.render(null, { risk: 'idle', alerts: [] }); return; }
    try {
      const watcher = fs.watch(projects, { recursive: true }, (_event, file) => {
        if (!file || !file.endsWith('.jsonl')) return;
        clearTimeout(this.scanTimer);
        this.scanTimer = setTimeout(() => this.scan(), 350);
      });
      this.context.subscriptions.push({ dispose: () => watcher.close() });
    } catch { this.poller = setInterval(() => this.scan(), 5000); this.context.subscriptions.push({ dispose: () => clearInterval(this.poller) }); }
  }

  scan() {
    let changes = 0;
    for (const file of recentJsonl(path.join(this.config.dataDirectory, 'projects'))) changes += this.readIncrement(file);
    this.store.save();
    if (changes > 0 && !this.bootstrapping) this.refreshQuota();
  }

  readIncrement(file) {
    let stat;
    try { stat = fs.statSync(file); } catch { return 0; }
    let offset = this.state.offsets[file] || 0;
    if (stat.size < offset) offset = 0;
    if (stat.size === offset) return 0;
    const length = stat.size - offset;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buffer, 0, length, offset); } finally { fs.closeSync(fd); }
    this.state.offsets[file] = stat.size;
    let processed = 0;
    for (const line of buffer.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let entry; try { entry = JSON.parse(line); } catch { continue; }
      const turn = usageFromEntry(entry);
      if (!turn || (turn.id && this.state.seen.includes(turn.id))) continue;
      this.processTurn(turn, file);
      processed++;
    }
    return processed;
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
    analysis.forecast = bootstrapForecast(this.state.slices.slice(-12).map(s => s.fresh));
    this.alertState = transitionAlertState(this.alertState, analysis.risk, turn.timestamp);
    analysis.displayRisk = this.alertState.level;
    this.lastAnalysis = analysis;
    this.render(turn, analysis);
    if (!this.bootstrapping && analysis.alerts.length && this.alertState.shouldNotify && Date.now() >= this.mutedUntil) this.alert(turn, analysis);
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
      this.store.save();
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
      this.healthStatus.text = '$(shield) Claude: idle';
      this.healthStatus.tooltip = `Waiting for Claude Code activity in ${this.config.dataDirectory}`;
      this.quotaStatus.hide(); this.cacheStatus.hide();
      return;
    }
    const risk = analysis.displayRisk || analysis.risk;
    const icon = risk === 'critical' ? '$(flame)' : risk === 'warning' ? '$(warning)' : '$(shield-check)';
    const quota = this.state.quotaSnapshots.at(-1);
    const delta = quota?.delta5h;
    this.healthStatus.text = risk === 'critical'
      ? `${icon} STOP${delta !== null && delta !== undefined ? ` · +${(delta * 100).toFixed(1)}%` : ''}`
      : risk === 'warning' ? `${icon} WATCH · ${Math.round(analysis.score || 0)}` : `${icon} SAFE`;
    this.healthStatus.backgroundColor = risk === 'critical' ? new vscode.ThemeColor('statusBarItem.errorBackground') : risk === 'warning' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.cacheStatus.text = `$(database) Cache ${turn.cacheHit.toFixed(0)}%`;
    this.cacheStatus.color = turn.cacheHit < 60 ? new vscode.ThemeColor('errorForeground') : turn.cacheHit < 80 ? new vscode.ThemeColor('editorWarning.foreground') : undefined;
    this.cacheStatus.show();
    if (quota) {
      this.quotaStatus.text = `$(dashboard) 5h ${(quota.utilization5h * 100).toFixed(0)}%`;
      this.quotaStatus.color = quota.utilization5h >= 0.9 ? new vscode.ThemeColor('errorForeground') : quota.utilization5h >= 0.7 ? new vscode.ThemeColor('editorWarning.foreground') : undefined;
      this.quotaStatus.show();
    } else this.quotaStatus.hide();
    const tooltip = this.tooltip(turn, analysis);
    this.healthStatus.tooltip = tooltip; this.quotaStatus.tooltip = tooltip; this.cacheStatus.tooltip = tooltip;
  }

  tooltip(turn, analysis) {
    const slice = this.state.slices.at(-1);
    const issues = (analysis.alerts || []).map(a => `- **${a.code}** — ${a.text}`).join('\n') || 'No anomaly detected.';
    const quota = this.state.quotaSnapshots.at(-1);
    const risk = analysis.displayRisk || analysis.risk;
    const heading = risk === 'critical' ? '🔥 STOP — drain detected' : risk === 'warning' ? '⚠️ WATCH — unusual activity' : '✅ SAFE — no drain detected';
    const quotaRow = quota ? `${(quota.utilization5h * 100).toFixed(1)}%${quota.delta5h === null || quota.delta5h === undefined ? '' : ` (+${(quota.delta5h * 100).toFixed(1)} pts / 5m)`}` : this.config.quotaEnabled ? 'Unavailable' : 'Off';
    const next = analysis.forecast ? `${compact(analysis.forecast.p50)} median / ${compact(analysis.forecast.p90)} p90` : 'Learning';
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.appendMarkdown(`### ${heading}\n\n`);
    if (risk === 'critical') markdown.appendMarkdown('**Do not submit another prompt until you inspect this incident.**\n\n');
    markdown.appendMarkdown(`| Signal | Now | Meaning |\n|---|---:|---|\n| 5-hour quota | ${quotaRow} | Subscription allowance |\n| Prompt cache | ${turn.cacheHit.toFixed(1)}% | Higher is better |\n| Risk | ${Math.round(analysis.score || 0)}/100 | Combined anomaly score |\n| Current 5m | ${compact(slice?.fresh || 0)} fresh | ${slice?.calls || 0} calls |\n| Next 30m | ${next} | Bootstrap forecast |\n\n`);
    markdown.appendMarkdown(`**Why**\n\n${issues}\n\n`);
    markdown.appendMarkdown(`_${turn.model} · ${turn.project} · ${turn.contextBucket} context bucket_`);
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
    const lines = turns.map(t => `${new Date(t.timestamp).toLocaleTimeString()}  cache ${t.cacheHit.toFixed(0)}%  fresh ${compact(t.fresh)}  out ${compact(t.output)}${t.alerts?.length ? `  ⚠ ${t.alerts.map(a => a.code).join(', ')}` : ''}`);
    vscode.window.showQuickPick(lines.length ? lines : ['No Claude turns observed yet'], { title: 'Claude Drain Guard — latest turns', placeHolder: 'Five-minute slices are retained for 24 hours' });
  }
}

function recentJsonl(root) {
  if (!fs.existsSync(root)) return [];
  const result = [], stack = [root], cutoff = Date.now() - 48 * 60 * 60_000;
  while (stack.length) {
    const dir = stack.pop();
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith('.jsonl')) { try { if (fs.statSync(full).mtimeMs >= cutoff) result.push(full); } catch {} }
    }
  }
  return result;
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

function deactivate() {}
module.exports = { activate, deactivate, recentJsonl };
