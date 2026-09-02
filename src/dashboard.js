'use strict';

const { compact } = require('./detector');
const { formatStatus } = require('./display');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function buildDashboard(state, options = {}) {
  const turn = state.turns.at(-1);
  const slice = state.slices.at(-1);
  const quota = state.quotaSnapshots.at(-1);
  const risk = turn?.risk || 'healthy';
  const riskLabel = risk === 'critical' ? 'Critical anomaly' : risk === 'warning' ? 'Usage anomaly' : 'Normal';
  const status = formatStatus({ quota, cacheHit: turn?.cacheHit, sliceFresh: slice?.fresh || 0, provider: options.provider, quotaEnabled: options.quotaEnabled });
  const usageValue = quota ? status.split(' · ')[0] : options.provider === 'api-key' || options.provider === 'aws-bedrock' ? `${options.provider} · ${compact(slice?.fresh || 0)} / 5m` : options.quotaEnabled ? 'Unavailable' : 'Local only';
  const recentSlices = state.slices.slice(-288);
  const maximum = Math.max(1, ...recentSlices.map(item => item.fresh || 0));
  const bars = recentSlices.map(item => {
    const height = Math.max(2, Math.round((item.fresh || 0) / maximum * 100));
    const label = `${new Date(item.start).toLocaleTimeString()} · ${compact(item.fresh || 0)} fresh · ${Math.round(item.cacheHit || 0)}% cache`;
    return `<span class="bar" style="height:${height}%" title="${escapeHtml(label)}"></span>`;
  }).join('');
  const incidents = state.turns.filter(item => item.risk !== 'healthy').slice(-12).reverse();
  const rows = incidents.length ? incidents.map(item => `<tr><td>${escapeHtml(new Date(item.timestamp).toLocaleString())}</td><td><span class="dot ${item.risk}"></span>${escapeHtml(item.risk === 'critical' ? 'Critical' : 'Elevated')}</td><td>${item.cacheHit.toFixed(0)}%</td><td>${compact(item.fresh)}</td><td>${escapeHtml((item.alerts || []).map(alert => alert.text).join(' · '))}</td></tr>`).join('') : '<tr><td colspan="5" class="muted">No anomalies recorded.</td></tr>';
  const quotaButton = options.quotaEnabled ? '<span class="quiet">Live 5h/7d enabled</span>' : '<button data-action="enableQuota">Enable 5h/7d usage</button>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeHtml(options.cspSource)} 'unsafe-inline'; script-src 'nonce-${escapeHtml(options.nonce)}';"><style>
    body{padding:22px 28px;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:var(--vscode-font-size)/1.45 var(--vscode-font-family);max-width:1180px;margin:auto}header,.toolbar,.section-head{display:flex;align-items:center;justify-content:space-between;gap:12px}h1{font-size:20px;font-weight:500;margin:0}h2{font-size:13px;font-weight:500;margin:0}.state{display:flex;align-items:center;gap:7px}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;background:var(--vscode-charts-blue)}.dot.warning{background:var(--vscode-charts-yellow)}.dot.critical{background:var(--vscode-charts-red)}.summary{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:22px;margin:28px 0 32px}.metric{border-bottom:1px solid var(--vscode-widget-border);padding-bottom:12px}.label,.muted,.quiet{color:var(--vscode-descriptionForeground)}.value{font-size:20px;margin-top:4px;font-variant-numeric:tabular-nums}.toolbar{justify-content:flex-start;flex-wrap:wrap;margin:14px 0 28px}button{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);border:0;padding:6px 11px;border-radius:2px;font:inherit;cursor:pointer}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button.primary{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}.chart{height:150px;display:flex;align-items:flex-end;gap:1px;border-bottom:1px solid var(--vscode-widget-border);margin:13px 0 7px}.bar{flex:1;min-width:1px;background:var(--vscode-charts-blue);opacity:.72}.axis{display:flex;justify-content:space-between;color:var(--vscode-descriptionForeground);font-size:11px;margin-bottom:32px}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{text-align:left;padding:8px 7px;border-bottom:1px solid var(--vscode-widget-border)}th{font-weight:500;color:var(--vscode-descriptionForeground)}td:nth-child(3),td:nth-child(4){font-variant-numeric:tabular-nums}@media(max-width:700px){.summary{grid-template-columns:repeat(2,1fr)}body{padding:16px}table{font-size:12px}}
  </style></head><body>
    <header><h1>Claude Drain Guard</h1><div class="state"><span class="dot ${escapeHtml(risk)}"></span>${escapeHtml(riskLabel)}</div></header>
    <div class="toolbar"><button class="primary" data-action="refresh">Refresh now</button><button data-action="interval">Refresh every ${Number(options.refreshIntervalSeconds) || 15}s</button><button data-action="report">Generate report</button>${quotaButton}</div>
    <section class="summary"><div class="metric"><div class="label">Usage</div><div class="value">${escapeHtml(usageValue)}</div></div><div class="metric"><div class="label">Cache hit</div><div class="value">${Number.isFinite(turn?.cacheHit) ? `${turn.cacheHit.toFixed(0)}%` : '—'}</div></div><div class="metric"><div class="label">Fresh input · 5m</div><div class="value">${compact(slice?.fresh || 0)}</div></div><div class="metric"><div class="label">Risk score</div><div class="value">${Math.round(turn?.riskScore || 0)} / 100</div></div></section>
    <section><div class="section-head"><h2>Fresh input · last 24 hours</h2><span class="quiet">5-minute slices</span></div><div class="chart" role="img" aria-label="Fresh input over the last 24 hours">${bars}</div><div class="axis"><span>24h ago</span><span>now</span></div></section>
    <section><div class="section-head"><h2>Recent anomalies</h2><span class="quiet">No prompt content stored</span></div><table><thead><tr><th>Time</th><th>State</th><th>Cache</th><th>Fresh</th><th>Signal</th></tr></thead><tbody>${rows}</tbody></table></section>
    <script nonce="${escapeHtml(options.nonce)}">const vscode=acquireVsCodeApi();document.addEventListener('click',event=>{const action=event.target.dataset.action;if(action)vscode.postMessage({action});});</script>
  </body></html>`;
}

module.exports = { buildDashboard, escapeHtml };
