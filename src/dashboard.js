'use strict';

const { compact } = require('./detector');
const { formatStatus } = require('./display');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function riskRank(risk) { return risk === 'critical' ? 2 : risk === 'warning' ? 1 : 0; }

function timeline24h(slices, turns = [], now = Date.now()) {
  const width = 5 * 60_000;
  const end = Math.floor(now / width) * width;
  const byStart = new Map((slices || []).map(slice => [slice.start, slice]));
  const riskByStart = new Map();
  for (const turn of turns || []) {
    const start = Math.floor(turn.timestamp / width) * width;
    if (start < end - 287 * width || start > end) continue;
    const current = riskByStart.get(start) || 'healthy';
    if (riskRank(turn.risk) > riskRank(current)) riskByStart.set(start, turn.risk);
  }
  return Array.from({ length: 288 }, (_, index) => {
    const start = end - (287 - index) * width;
    const slice = byStart.get(start) || {};
    return { start, fresh: Number(slice.fresh) || 0, cacheHit: Number.isFinite(slice.cacheHit) ? slice.cacheHit : null, calls: Number(slice.calls) || 0, risk: riskByStart.get(start) || 'healthy' };
  });
}

function incidentEvidence(alerts) {
  const codes = new Set(alerts.map(alert => alert.code));
  const labels = [];
  if (codes.has('CACHE_CLIFF') || codes.has('CACHE_COLLAPSE')) labels.push('Cache collapse');
  if (codes.has('FRESH_SPIKE')) labels.push('High fresh input');
  if (codes.has('QUOTA_SPIKE')) labels.push('5h usage jump');
  if (codes.has('CACHE_MISS')) labels.push('Low cache hit');
  if ([...codes].some(code => ['ROBUST_SPIKE', 'CHANGE_POINT', 'CUSUM', 'MULTIVARIATE', 'BURN_ACCELERATION'].includes(code))) labels.push('Statistical shift');
  return labels.join(' · ') || 'Anomalous activity';
}

function clusterIncidents(turns, gapMs = 10 * 60_000) {
  const incidents = [];
  let active = null;
  for (const turn of [...(turns || [])].sort((a, b) => a.timestamp - b.timestamp)) {
    if (turn.risk === 'healthy') { active = null; continue; }
    if (!active || turn.timestamp - active.end > gapMs) {
      active = { start: turn.timestamp, end: turn.timestamp, risk: turn.risk, turns: 0, minCache: 100, totalFresh: 0, peakFresh: 0, cost: 0, costCount: 0, alerts: [] };
      incidents.push(active);
    }
    active.end = turn.timestamp;
    active.turns += 1;
    active.risk = riskRank(turn.risk) > riskRank(active.risk) ? turn.risk : active.risk;
    active.minCache = Math.min(active.minCache, Number(turn.cacheHit) || 0);
    active.totalFresh += Number(turn.fresh) || 0;
    active.peakFresh = Math.max(active.peakFresh, Number(turn.fresh) || 0);
    if (Number.isFinite(turn.costUsd)) { active.cost += turn.costUsd; active.costCount += 1; }
    active.alerts.push(...(turn.alerts || []));
  }
  return incidents;
}

function buildDashboard(state, options = {}) {
  const turn = state.turns.at(-1);
  const slice = state.slices.at(-1);
  const quota = state.quotaSnapshots.at(-1);
  const risk = options.displayRisk || turn?.risk || 'healthy';
  const riskLabel = risk === 'critical' ? 'Critical anomaly' : risk === 'warning' ? 'Usage anomaly' : 'Normal';
  const status = formatStatus({ quota, cacheHit: turn?.cacheHit, sliceFresh: slice?.fresh || 0, provider: options.provider, quotaEnabled: options.quotaEnabled });
  const usageValue = quota ? status.split(' · ')[0] : options.provider === 'api-key' || options.provider === 'aws-bedrock' ? `${options.provider} · ${compact(slice?.fresh || 0)} / 5m` : options.quotaEnabled ? 'Waiting to connect' : 'Local only';
  const timeline = timeline24h(state.slices, state.turns, options.now);
  const recentTurns = state.turns.filter(item => item.timestamp >= (options.now || Date.now()) - 24 * 60 * 60_000);
  const knownCosts = recentTurns.filter(item => Number.isFinite(item.costUsd));
  const cost24h = knownCosts.reduce((sum, item) => sum + item.costUsd, 0);
  const reportedCosts = knownCosts.filter(item => item.costSource === 'reported').length;
  const costCaption = !knownCosts.length ? 'no supported model data' : reportedCosts === knownCosts.length ? 'Claude estimate · not Max billing' : reportedCosts ? 'mixed reported + local estimate' : 'local estimate · not Max billing';
  const incidents = clusterIncidents(state.turns).slice(-10).reverse();
  const rows = incidents.length ? incidents.map(item => `<tr><td>${escapeHtml(new Date(item.start).toLocaleString())}</td><td><span class="dot ${item.risk}"></span>${escapeHtml(item.risk === 'critical' ? 'Critical' : 'Elevated')}</td><td>${item.turns}</td><td>${item.minCache.toFixed(0)}%</td><td title="Peak ${compact(item.peakFresh)}">${compact(item.totalFresh)}</td><td>${item.costCount ? `$${item.cost.toFixed(2)}` : '—'}</td><td>${escapeHtml(incidentEvidence(item.alerts))}</td></tr>`).join('') : '<tr><td colspan="7" class="muted">No anomalies recorded.</td></tr>';
  const quotaButton = quota ? '<span class="quiet">Live 5h/7d connected</span>' : options.quotaEnabled ? '<button data-action="connectUsage">Connect live usage</button>' : '<button data-action="enableQuota">Enable 5h/7d usage</button>';
  const chartData = JSON.stringify(timeline).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeHtml(options.cspSource)} 'unsafe-inline'; script-src 'nonce-${escapeHtml(options.nonce)}';"><style>
    body{padding:22px 28px;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:var(--vscode-font-size)/1.45 var(--vscode-font-family);max-width:1180px;margin:auto}header,.toolbar,.section-head{display:flex;align-items:center;justify-content:space-between;gap:12px}h1{font-size:20px;font-weight:500;margin:0}h2{font-size:13px;font-weight:500;margin:0}.state{display:flex;align-items:center;gap:7px}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;background:var(--vscode-charts-blue)}.dot.warning{background:var(--vscode-charts-yellow)}.dot.critical{background:var(--vscode-charts-red)}.summary{display:grid;grid-template-columns:repeat(5,minmax(110px,1fr));gap:22px;margin:28px 0 32px}.metric{border-bottom:1px solid var(--vscode-widget-border);padding-bottom:12px}.label,.muted,.quiet{color:var(--vscode-descriptionForeground)}.value{font-size:20px;margin-top:4px;font-variant-numeric:tabular-nums}.subvalue{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:2px}.toolbar{justify-content:flex-start;flex-wrap:wrap;margin:14px 0 28px}button{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);border:0;padding:6px 11px;border-radius:2px;font:inherit;cursor:pointer}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button.primary{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}.segments{display:flex;border:1px solid var(--vscode-widget-border);border-radius:3px;overflow:hidden}.segments button{border-radius:0;padding:3px 9px;background:transparent;color:var(--vscode-descriptionForeground)}.segments button.active{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-foreground)}.chart{height:150px;display:flex;align-items:flex-end;gap:1px;border-bottom:1px solid var(--vscode-widget-border);margin:13px 0 7px}.bar{flex:1;min-width:1px;background:var(--vscode-charts-blue);opacity:.72}.bar.warning{background:var(--vscode-charts-yellow)}.bar.critical{background:var(--vscode-charts-red)}.axis{display:flex;justify-content:space-between;color:var(--vscode-descriptionForeground);font-size:11px;margin-bottom:6px}.chart-note{text-align:right;color:var(--vscode-descriptionForeground);font-size:11px;margin-bottom:28px}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{text-align:left;padding:8px 7px;border-bottom:1px solid var(--vscode-widget-border)}th{font-weight:500;color:var(--vscode-descriptionForeground)}td:nth-child(3),td:nth-child(4),td:nth-child(5),td:nth-child(6){font-variant-numeric:tabular-nums}@media(max-width:820px){.summary{grid-template-columns:repeat(2,1fr)}body{padding:16px}.table-wrap{overflow-x:auto}table{font-size:12px;min-width:760px}}
  </style></head><body>
    <header><h1>Claude Drain Guard</h1><div class="state"><span class="dot ${escapeHtml(risk)}"></span>${escapeHtml(riskLabel)}</div></header>
    <div class="toolbar"><button class="primary" data-action="refresh">Refresh now</button><button data-action="interval">Refresh every ${Number(options.refreshIntervalSeconds) || 15}s</button><button data-action="report">Generate report</button>${quotaButton}</div>
    <section class="summary"><div class="metric"><div class="label">Usage</div><div class="value">${escapeHtml(usageValue)}</div></div><div class="metric"><div class="label">Cache hit</div><div class="value">${Number.isFinite(turn?.cacheHit) ? `${turn.cacheHit.toFixed(0)}%` : '—'}</div></div><div class="metric"><div class="label">Fresh input · 5m</div><div class="value">${compact(slice?.fresh || 0)}</div></div><div class="metric"><div class="label">API-equivalent · 24h</div><div class="value">${knownCosts.length ? `$${cost24h.toFixed(2)}` : '—'}</div><div class="subvalue">${escapeHtml(costCaption)}</div></div><div class="metric"><div class="label">Risk score</div><div class="value">${Math.round(turn?.riskScore || 0)} / 100</div></div></section>
    <section><div class="section-head"><h2>Fresh input · last 24 hours</h2><div class="segments" aria-label="Chart bucket size"><button class="active" data-bucket="5">5m</button><button data-bucket="30">30m</button><button data-bucket="60">1h</button></div></div><div id="chart" class="chart" role="img" aria-label="Fresh input over the last 24 hours"></div><div class="axis"><span>24h ago</span><span>now</span></div><div id="chart-note" class="chart-note"></div></section>
    <section><div class="section-head"><h2>Recent incidents</h2><span class="quiet">Consecutive alerts grouped · no prompt content stored</span></div><div class="table-wrap"><table><thead><tr><th>Start</th><th>Severity</th><th>Turns</th><th>Cache low</th><th>Fresh total</th><th>Cost est.</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></div></section>
    <script nonce="${escapeHtml(options.nonce)}">const vscode=acquireVsCodeApi();const timeline=${chartData};const rank={healthy:0,warning:1,critical:2};function aggregate(minutes){const size=minutes/5,result=[];for(let i=0;i<timeline.length;i+=size){const part=timeline.slice(i,i+size);result.push({start:part[0].start,fresh:part.reduce((n,x)=>n+x.fresh,0),calls:part.reduce((n,x)=>n+x.calls,0),risk:part.reduce((r,x)=>rank[x.risk]>rank[r]?x.risk:r,'healthy')});}return result;}function renderChart(minutes){const data=aggregate(minutes),peak=Math.max(0,...data.map(x=>x.fresh)),denominator=Math.log1p(peak)||1,chart=document.getElementById('chart');chart.textContent='';for(const item of data){const bar=document.createElement('span');bar.className='bar '+item.risk;bar.style.height=item.fresh?Math.max(3,Math.round(Math.log1p(item.fresh)/denominator*100))+'%':'0';bar.title=new Date(item.start).toLocaleTimeString()+' · '+item.fresh.toLocaleString()+' fresh · '+item.calls+' calls';chart.appendChild(bar);}document.getElementById('chart-note').textContent=data.length+' buckets · peak '+peak.toLocaleString()+' fresh · log scale';document.querySelectorAll('[data-bucket]').forEach(x=>x.classList.toggle('active',Number(x.dataset.bucket)===minutes));}document.addEventListener('click',event=>{const action=event.target.dataset.action;if(action)vscode.postMessage({action});const bucket=Number(event.target.dataset.bucket);if(bucket)renderChart(bucket);});renderChart(5);</script>
  </body></html>`;
}

module.exports = { buildDashboard, escapeHtml, timeline24h, clusterIncidents, incidentEvidence };
