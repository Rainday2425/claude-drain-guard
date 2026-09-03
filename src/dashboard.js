'use strict';

const { compact } = require('./detector');
const { formatStatus } = require('./display');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function riskRank(risk) { return risk === 'critical' ? 2 : risk === 'warning' ? 1 : 0; }
function highestRisk(left, right) { return riskRank(right) > riskRank(left) ? right : left; }
function money(value) { return Number.isFinite(value) ? `$${value.toFixed(2)}` : '—'; }

function timeline24h(slices, turns = [], now = Date.now()) {
  const width = 5 * 60_000;
  const end = Math.floor(now / width) * width;
  const beginning = end - 287 * width;
  const byStart = new Map((slices || []).map(slice => [slice.start, slice]));
  const fromTurns = new Map();
  for (const turn of turns || []) {
    const start = Math.floor(turn.timestamp / width) * width;
    if (start < beginning || start > end) continue;
    const bucket = fromTurns.get(start) || { fresh: 0, calls: 0, cacheRead: 0, totalInput: 0, cost: 0, costCount: 0, risk: 'healthy' };
    bucket.fresh += Number(turn.fresh) || 0;
    bucket.calls += 1;
    bucket.cacheRead += Number(turn.cacheRead) || 0;
    bucket.totalInput += Number(turn.totalInput) || 0;
    if (Number.isFinite(turn.costUsd)) { bucket.cost += turn.costUsd; bucket.costCount += 1; }
    bucket.risk = highestRisk(bucket.risk, turn.risk);
    fromTurns.set(start, bucket);
  }
  return Array.from({ length: 288 }, (_, index) => {
    const start = beginning + index * width;
    const slice = byStart.get(start);
    const fallback = fromTurns.get(start) || {};
    const totalInput = Number(fallback.totalInput) || 0;
    return {
      start,
      fresh: slice ? Number(slice.fresh) || 0 : Number(fallback.fresh) || 0,
      cacheHit: slice && Number.isFinite(slice.cacheHit) ? slice.cacheHit : totalInput ? fallback.cacheRead / totalInput * 100 : null,
      calls: slice ? Number(slice.calls) || 0 : Number(fallback.calls) || 0,
      cost: Number(fallback.cost) || 0,
      costCount: Number(fallback.costCount) || 0,
      cacheRead: Number(fallback.cacheRead) || 0,
      totalInput,
      risk: fallback.risk || 'healthy'
    };
  });
}

function currentSession(turns = [], sessions = [], now = Date.now()) {
  const latestFile = [...sessions].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))[0];
  const latestTurn = turns.at(-1);
  const sessionId = latestFile?.sessionId || latestTurn?.sessionId;
  if (!sessionId && !latestTurn) return null;
  let sessionTurns = sessionId ? turns.filter(turn => turn.sessionId === sessionId) : [];
  // Records written by older releases have no sessionId. Recover only the
  // latest contiguous run for the active file's project; a 30-minute gap is a
  // natural session boundary and avoids a full historical replay.
  const project = latestFile?.project || sessionTurns.at(-1)?.project || latestTurn?.project;
  const candidates = turns.filter(turn => (!project || turn.project === project) && (!turn.sessionId || turn.sessionId === sessionId)).sort((a, b) => a.timestamp - b.timestamp);
  if (candidates.length) {
    let start = candidates.length - 1;
    while (start > 0 && candidates[start].timestamp - candidates[start - 1].timestamp <= 30 * 60_000) start -= 1;
    const contiguous = candidates.slice(start);
    if (!sessionTurns.length || contiguous.some(turn => !turn.sessionId)) sessionTurns = contiguous;
  }
  if (!sessionTurns.length && latestTurn) sessionTurns = [latestTurn];
  const lastTurnAt = Math.max(0, ...sessionTurns.map(turn => turn.timestamp || 0));
  const lastActivity = Math.max(latestFile?.lastActivity || 0, lastTurnAt);
  const totalInput = sessionTurns.reduce((sum, turn) => sum + (Number(turn.totalInput) || 0), 0);
  const cacheRead = sessionTurns.reduce((sum, turn) => sum + (Number(turn.cacheRead) || 0), 0);
  const costs = sessionTurns.filter(turn => Number.isFinite(turn.costUsd));
  return {
    sessionId: sessionId || 'unknown',
    project: project || sessionTurns.at(-1)?.project || 'unknown',
    active: now - lastActivity <= 30 * 60_000,
    start: Math.min(...sessionTurns.map(turn => turn.timestamp || lastActivity), lastActivity),
    lastActivity,
    turns: sessionTurns,
    responses: sessionTurns.length,
    fresh: sessionTurns.reduce((sum, turn) => sum + (Number(turn.fresh) || 0), 0),
    output: sessionTurns.reduce((sum, turn) => sum + (Number(turn.output) || 0), 0),
    cacheHit: totalInput ? cacheRead / totalInput * 100 : null,
    cost: costs.length ? costs.reduce((sum, turn) => sum + turn.costUsd, 0) : null
  };
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
    active.risk = highestRisk(active.risk, turn.risk);
    active.minCache = Math.min(active.minCache, Number(turn.cacheHit) || 0);
    active.totalFresh += Number(turn.fresh) || 0;
    active.peakFresh = Math.max(active.peakFresh, Number(turn.fresh) || 0);
    if (Number.isFinite(turn.costUsd)) { active.cost += turn.costUsd; active.costCount += 1; }
    active.alerts.push(...(turn.alerts || []));
  }
  return incidents;
}

function barHeight(value, peak) {
  return value > 0 && peak > 0 ? Math.max(4, Math.round(Math.log1p(value) / Math.log1p(peak) * 100)) : 0;
}

function historyTooltip(item, minutes = 5) {
  const start = new Date(item.start).toLocaleString();
  const cache = Number.isFinite(item.cacheHit) ? `${item.cacheHit.toFixed(0)}%` : '—';
  return `${start} · ${minutes}m\nFresh input ${Math.round(item.fresh).toLocaleString()} tokens\nCache hit ${cache} · ${item.calls} API response${item.calls === 1 ? '' : 's'}${item.costCount ? `\nAPI-equivalent ${money(item.cost)}` : ''}`;
}

function historyBars(items) {
  const peak = Math.max(0, ...items.map(item => item.fresh));
  return items.map(item => `<span class="bar ${escapeHtml(item.risk)}" style="height:${barHeight(item.fresh, peak)}%" data-tooltip="${escapeHtml(historyTooltip(item))}" title="${escapeHtml(historyTooltip(item).replace(/\n/g, ' · '))}" aria-label="${escapeHtml(historyTooltip(item).replace(/\n/g, ', '))}"></span>`).join('');
}

function sessionBars(session) {
  const peak = Math.max(0, ...session.turns.map(turn => Number(turn.fresh) || 0));
  return session.turns.map((turn, index) => {
    const cache = Number.isFinite(turn.cacheHit) ? `${turn.cacheHit.toFixed(0)}%` : '—';
    const label = `Response ${index + 1} · ${new Date(turn.timestamp).toLocaleTimeString()}\nFresh input ${(Number(turn.fresh) || 0).toLocaleString()} tokens\nCache hit ${cache} · output ${(Number(turn.output) || 0).toLocaleString()}${Number.isFinite(turn.costUsd) ? `\nAPI-equivalent ${money(turn.costUsd)}` : ''}`;
    return `<span class="session-bar ${escapeHtml(turn.risk)}" style="height:${barHeight(Number(turn.fresh) || 0, peak)}%" data-tooltip="${escapeHtml(label)}" title="${escapeHtml(label.replace(/\n/g, ' · '))}" aria-label="${escapeHtml(label.replace(/\n/g, ', '))}"></span>`;
  }).join('');
}

function buildDashboard(state, options = {}) {
  const now = options.now || Date.now();
  const turn = state.turns.at(-1);
  const slice = state.slices.at(-1);
  const quota = state.quotaSnapshots.at(-1);
  const risk = options.displayRisk || turn?.risk || 'healthy';
  const riskLabel = risk === 'critical' ? 'Critical anomaly' : risk === 'warning' ? 'Usage anomaly' : 'Normal';
  const status = formatStatus({ quota, cacheHit: turn?.cacheHit, sliceFresh: slice?.fresh || 0, provider: options.provider, quotaEnabled: options.quotaEnabled });
  const usageValue = quota ? status.split(' · ')[0] : options.provider === 'api-key' || options.provider === 'aws-bedrock' ? `${options.provider} · ${compact(slice?.fresh || 0)} / 5m` : options.quotaEnabled ? 'Waiting to connect' : 'Local only';
  const timeline = timeline24h(state.slices, state.turns, now);
  const liveSession = currentSession(state.turns, options.sessions || [], now);
  const recentTurns = state.turns.filter(item => item.timestamp >= now - 24 * 60 * 60_000);
  const knownCosts = recentTurns.filter(item => Number.isFinite(item.costUsd));
  const cost24h = knownCosts.reduce((sum, item) => sum + item.costUsd, 0);
  const reportedCosts = knownCosts.filter(item => item.costSource === 'reported').length;
  const costCaption = !knownCosts.length ? 'no supported model data' : reportedCosts === knownCosts.length ? 'Claude estimate · not Max billing' : reportedCosts ? 'mixed reported + local estimate' : 'local estimate · not Max billing';
  const incidents = clusterIncidents(state.turns).slice(-10).reverse();
  const rows = incidents.length ? incidents.map(item => `<tr><td>${escapeHtml(new Date(item.start).toLocaleString())}</td><td><span class="dot ${item.risk}"></span>${escapeHtml(item.risk === 'critical' ? 'Critical' : 'Elevated')}</td><td>${item.turns}</td><td>${item.minCache.toFixed(0)}%</td><td title="Peak ${compact(item.peakFresh)}">${compact(item.totalFresh)}</td><td>${item.costCount ? money(item.cost) : '—'}</td><td>${escapeHtml(incidentEvidence(item.alerts))}</td></tr>`).join('') : '<tr><td colspan="7" class="muted">No anomalies recorded.</td></tr>';
  const quotaButton = quota ? '<span class="quiet">Live 5h/7d connected</span>' : options.quotaEnabled ? '<button data-action="connectUsage">Connect live usage</button>' : '<button data-action="enableQuota">Enable 5h/7d usage</button>';
  const chartData = JSON.stringify(timeline).replace(/</g, '\\u003c');
  const historyPeak = Math.max(0, ...timeline.map(item => item.fresh));
  const historyMid = Math.expm1(Math.log1p(historyPeak) / 2);
  const sessionPanel = liveSession ? `<section class="session-card"><div class="section-head"><div><h2>${liveSession.active ? 'Ongoing session' : 'Latest session'}</h2><div class="session-name">${escapeHtml(liveSession.project)}</div></div><div class="state"><span class="dot ${liveSession.active ? 'active' : ''}"></span>${liveSession.active ? 'Active' : `Last seen ${escapeHtml(new Date(liveSession.lastActivity).toLocaleString())}`}</div></div><div class="session-meta">${escapeHtml(liveSession.sessionId.slice(0, 8))} · started ${escapeHtml(new Date(liveSession.start).toLocaleTimeString())} · ${liveSession.responses} completed API response${liveSession.responses === 1 ? '' : 's'}</div><div class="session-metrics"><div><span>Fresh input</span><strong>${compact(liveSession.fresh)}</strong></div><div><span>Cache hit</span><strong>${Number.isFinite(liveSession.cacheHit) ? `${liveSession.cacheHit.toFixed(0)}%` : '—'}</strong></div><div><span>Output</span><strong>${compact(liveSession.output)}</strong></div><div><span>API-equivalent</span><strong>${money(liveSession.cost)}</strong></div></div>${liveSession.turns.length ? `<div class="session-chart" aria-label="Fresh input for each response in the current session">${sessionBars(liveSession)}</div><div class="chart-caption">Each bar is one completed API response · hover for exact tokens, cache and cost</div>` : '<div class="empty-chart">Session detected. Token data appears after the first Claude API response completes.</div>'}</section>` : '<section class="session-card"><h2>Ongoing session</h2><div class="empty-chart">No active Claude Code session detected yet.</div></section>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeHtml(options.cspSource)} 'unsafe-inline'; script-src 'nonce-${escapeHtml(options.nonce)}';"><style>
    body{padding:22px 28px;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:var(--vscode-font-size)/1.45 var(--vscode-font-family);max-width:1180px;margin:auto}header,.toolbar,.section-head{display:flex;align-items:center;justify-content:space-between;gap:12px}h1{font-size:20px;font-weight:500;margin:0}h2{font-size:13px;font-weight:600;margin:0}.state{display:flex;align-items:center;gap:5px;color:var(--vscode-descriptionForeground)}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;background:var(--vscode-charts-blue)}.dot.active{box-shadow:0 0 0 3px color-mix(in srgb,var(--vscode-charts-blue) 20%,transparent)}.dot.warning{background:var(--vscode-charts-yellow)}.dot.critical{background:var(--vscode-charts-red)}.summary{display:grid;grid-template-columns:repeat(5,minmax(110px,1fr));gap:22px;margin:28px 0 32px}.metric{border-bottom:1px solid var(--vscode-widget-border);padding-bottom:12px}.label,.muted,.quiet{color:var(--vscode-descriptionForeground)}.value{font-size:20px;margin-top:4px;font-variant-numeric:tabular-nums}.subvalue,.session-meta,.chart-caption{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:3px}.toolbar{justify-content:flex-start;flex-wrap:wrap;margin:14px 0 24px}button{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);border:0;padding:6px 11px;border-radius:2px;font:inherit;cursor:pointer}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button.primary{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}.session-card{border:1px solid var(--vscode-widget-border);background:var(--vscode-editorWidget-background,var(--vscode-editor-background));padding:16px 18px;margin-bottom:28px}.session-name{font-size:17px;margin-top:2px}.session-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:16px 0 12px}.session-metrics div{display:flex;flex-direction:column}.session-metrics span{font-size:11px;color:var(--vscode-descriptionForeground)}.session-metrics strong{font-size:16px;font-weight:500;font-variant-numeric:tabular-nums}.session-chart{height:86px;display:flex;align-items:flex-end;gap:3px;padding-top:8px;border-bottom:1px solid var(--vscode-widget-border)}.session-bar{width:clamp(5px,1.5vw,18px);min-width:5px;background:var(--vscode-charts-blue);opacity:.82;border-radius:1px 1px 0 0}.session-bar.warning{background:var(--vscode-charts-yellow)}.session-bar.critical{background:var(--vscode-charts-red)}.empty-chart{padding:18px 0 4px;color:var(--vscode-descriptionForeground)}.segments{display:flex;border:1px solid var(--vscode-widget-border);border-radius:3px;overflow:hidden}.segments button{border-radius:0;padding:3px 9px;background:transparent;color:var(--vscode-descriptionForeground)}.segments button.active{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-foreground)}.chart-shell{display:grid;grid-template-columns:48px 1fr;gap:8px;margin-top:12px}.y-axis{height:150px;display:flex;flex-direction:column;justify-content:space-between;text-align:right;color:var(--vscode-descriptionForeground);font-size:10px;font-variant-numeric:tabular-nums}.chart{height:150px;display:flex;align-items:flex-end;gap:1px;border-bottom:1px solid var(--vscode-widget-border);position:relative;background:repeating-linear-gradient(to bottom,transparent 0,transparent 49px,var(--vscode-widget-border) 50px)}.bar{flex:1;min-width:1px;background:var(--vscode-charts-blue);opacity:.72}.bar.warning{background:var(--vscode-charts-yellow)}.bar.critical{background:var(--vscode-charts-red)}.axis{display:flex;justify-content:space-between;color:var(--vscode-descriptionForeground);font-size:11px;margin:5px 0 0 56px}.chart-stats{display:flex;justify-content:flex-end;gap:18px;color:var(--vscode-descriptionForeground);font-size:11px;margin:5px 0 28px}.tooltip{position:fixed;z-index:10;display:none;pointer-events:none;white-space:pre-line;background:var(--vscode-editorHoverWidget-background);color:var(--vscode-editorHoverWidget-foreground);border:1px solid var(--vscode-editorHoverWidget-border,var(--vscode-widget-border));box-shadow:0 2px 8px var(--vscode-widget-shadow);padding:8px 10px;border-radius:3px;font-size:12px;line-height:1.45;max-width:280px}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{text-align:left;padding:8px 7px;border-bottom:1px solid var(--vscode-widget-border)}th{font-weight:500;color:var(--vscode-descriptionForeground)}td:nth-child(3),td:nth-child(4),td:nth-child(5),td:nth-child(6){font-variant-numeric:tabular-nums}@media(max-width:820px){.summary,.session-metrics{grid-template-columns:repeat(2,1fr)}body{padding:16px}.table-wrap{overflow-x:auto}table{font-size:12px;min-width:760px}}
  </style></head><body>
    <header><h1>Claude Drain Guard</h1><div class="state"><span class="dot ${escapeHtml(risk)}"></span>${escapeHtml(riskLabel)}</div></header>
    <div class="toolbar"><button class="primary" data-action="refresh">Refresh now</button><button data-action="interval">Refresh every ${Number(options.refreshIntervalSeconds) || 15}s</button><button data-action="report">Generate report</button>${quotaButton}</div>
    ${sessionPanel}
    <section class="summary"><div class="metric"><div class="label">Usage</div><div class="value">${escapeHtml(usageValue)}</div></div><div class="metric"><div class="label">Cache hit</div><div class="value">${Number.isFinite(turn?.cacheHit) ? `${turn.cacheHit.toFixed(0)}%` : '—'}</div></div><div class="metric"><div class="label">Fresh input · 5m</div><div class="value">${compact(slice?.fresh || 0)}</div></div><div class="metric"><div class="label">API-equivalent · 24h</div><div class="value">${knownCosts.length ? money(cost24h) : '—'}</div><div class="subvalue">${escapeHtml(costCaption)}</div></div><div class="metric"><div class="label">Risk score</div><div class="value">${Math.round(turn?.riskScore || 0)} / 100</div></div></section>
    <section><div class="section-head"><h2>Fresh input · last 24 hours</h2><div class="segments" aria-label="Chart bucket size"><button class="active" data-bucket="5">5m</button><button data-bucket="30">30m</button><button data-bucket="60">1h</button></div></div><div class="chart-shell"><div id="y-axis" class="y-axis"><span>${compact(historyPeak)}</span><span>${compact(historyMid)}</span><span>0</span></div><div id="chart" class="chart" role="img" aria-label="Fresh input over the last 24 hours">${historyBars(timeline)}</div></div><div class="axis"><span>24h ago</span><span>now</span></div><div id="chart-stats" class="chart-stats"><span>5m buckets</span><span>${timeline.reduce((sum, item) => sum + item.fresh, 0).toLocaleString()} total fresh</span><span>${historyPeak.toLocaleString()} peak</span></div></section>
    <section><div class="section-head"><h2>Recent incidents</h2><span class="quiet">Consecutive alerts grouped · no prompt content stored</span></div><div class="table-wrap"><table><thead><tr><th>Start</th><th>Severity</th><th>Turns</th><th>Cache low</th><th>Fresh total</th><th>Cost est.</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table></div></section>
    <div id="tooltip" class="tooltip" role="tooltip"></div>
    <script nonce="${escapeHtml(options.nonce)}">let vscode={postMessage:()=>{}};try{vscode=acquireVsCodeApi();}catch{}const timeline=${chartData};const rank={healthy:0,warning:1,critical:2};const nl=String.fromCharCode(10);const compact=n=>n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?Math.round(n/1e3)+'k':Math.round(n).toString();function aggregate(minutes){const size=minutes/5,result=[];for(let i=0;i<timeline.length;i+=size){const part=timeline.slice(i,i+size),totalInput=part.reduce((n,x)=>n+x.totalInput,0),cacheRead=part.reduce((n,x)=>n+x.cacheRead,0);result.push({start:part[0].start,fresh:part.reduce((n,x)=>n+x.fresh,0),calls:part.reduce((n,x)=>n+x.calls,0),cost:part.reduce((n,x)=>n+x.cost,0),costCount:part.reduce((n,x)=>n+x.costCount,0),cacheHit:totalInput?cacheRead/totalInput*100:null,risk:part.reduce((r,x)=>rank[x.risk]>rank[r]?x.risk:r,'healthy')});}return result;}function tip(item,minutes){const cache=Number.isFinite(item.cacheHit)?item.cacheHit.toFixed(0)+'%':'—',end=new Date(item.start+minutes*60000);return new Date(item.start).toLocaleString()+' – '+end.toLocaleTimeString()+nl+'Fresh input '+Math.round(item.fresh).toLocaleString()+' tokens'+nl+'Cache hit '+cache+' · '+item.calls+' API response'+(item.calls===1?'':'s')+(item.costCount?nl+'API-equivalent $'+item.cost.toFixed(2):'');}function renderChart(minutes){const data=aggregate(minutes),peak=Math.max(0,...data.map(x=>x.fresh)),denominator=Math.log1p(peak)||1,chart=document.getElementById('chart');chart.textContent='';for(const item of data){const bar=document.createElement('span'),label=tip(item,minutes);bar.className='bar '+item.risk;bar.style.height=item.fresh?Math.max(4,Math.round(Math.log1p(item.fresh)/denominator*100))+'%':'0';bar.dataset.tooltip=label;bar.title=label.replaceAll(nl,' · ');bar.setAttribute('aria-label',label.replaceAll(nl,', '));chart.appendChild(bar);}const midpoint=Math.expm1(Math.log1p(peak)/2);document.getElementById('y-axis').innerHTML='<span>'+compact(peak)+'</span><span>'+compact(midpoint)+'</span><span>0</span>';document.getElementById('chart-stats').innerHTML='<span>'+minutes+'m buckets</span><span>'+data.reduce((n,x)=>n+x.fresh,0).toLocaleString()+' total fresh</span><span>'+peak.toLocaleString()+' peak</span>';document.querySelectorAll('[data-bucket]').forEach(x=>x.classList.toggle('active',Number(x.dataset.bucket)===minutes));}const tooltip=document.getElementById('tooltip');document.addEventListener('pointerover',event=>{const target=event.target.closest('[data-tooltip]');if(!target)return;tooltip.textContent=target.dataset.tooltip;tooltip.style.display='block';});document.addEventListener('pointermove',event=>{if(tooltip.style.display!=='block')return;const left=Math.min(event.clientX+12,window.innerWidth-tooltip.offsetWidth-10),top=Math.max(8,event.clientY-tooltip.offsetHeight-12);tooltip.style.left=left+'px';tooltip.style.top=top+'px';});document.addEventListener('pointerout',event=>{if(event.target.closest('[data-tooltip]'))tooltip.style.display='none';});document.addEventListener('click',event=>{const action=event.target.dataset.action;if(action)vscode.postMessage({action});const bucket=Number(event.target.dataset.bucket);if(bucket)renderChart(bucket);});</script>
  </body></html>`;
}

module.exports = { buildDashboard, escapeHtml, timeline24h, currentSession, clusterIncidents, incidentEvidence };
