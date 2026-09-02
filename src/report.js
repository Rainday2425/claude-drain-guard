'use strict';
const { bootstrapForecast, compact } = require('./detector');

function generateReport(incident, turns, slices, config) {
  const forecast = bootstrapForecast(slices.slice(-12).map(s => s.fresh));
  const alertLines = (incident.alerts || []).map(a => `- **${a.code}**: ${a.text}`).join('\n') || '- No classified signal';
  const turnRows = turns.slice(-12).map(t => `| ${new Date(t.timestamp).toISOString()} | ${Math.round(t.cacheHit)}% | ${t.input} | ${t.cacheRead} | ${t.cacheWrite} | ${t.output} | ${Number.isFinite(t.costUsd) ? `$${t.costUsd.toFixed(4)} (${t.costSource || 'estimated'})` : '—'} | ${(t.alerts || []).map(a => a.code).join(', ') || '—'} |`).join('\n');
  const sliceRows = slices.slice(-12).map(s => `| ${new Date(s.start).toISOString()} | ${s.calls} | ${Math.round(s.cacheHit)}% | ${s.fresh} | ${s.cacheWrite} | ${s.output} |`).join('\n');
  return `# Claude Drain Incident Report

Generated locally by Claude Drain Guard. It contains usage metadata only—not prompts, responses, source code, credentials, or tool arguments.

## Incident

- Time: ${new Date(incident.timestamp).toISOString()}
- Severity: **${incident.risk.toUpperCase()}**
- Combined risk: **${Math.round(incident.riskScore || 0)}/100**
- Baseline group: **${incident.model || 'unknown'} × ${incident.project || 'unknown'} × ${incident.contextBucket || 'unknown'} × ${incident.cacheState || 'unknown'}**
- Cache hit: **${incident.cacheHit.toFixed(1)}%**
- Fresh input: **${incident.fresh} tokens**
- Cache read/write: **${incident.cacheRead} / ${incident.cacheWrite} tokens**
- Output: **${incident.output} tokens**
- API-equivalent cost: **${Number.isFinite(incident.costUsd) ? `$${incident.costUsd.toFixed(4)} (${incident.costSource || 'estimated'})` : 'unavailable'}**
- Authoritative 5h usage: **${incident.quota5h === undefined ? 'not sampled' : `${(incident.quota5h * 100).toFixed(1)}%`}**
- Five-minute 5h quota delta: **${incident.quotaDelta5h === undefined || incident.quotaDelta5h === null ? 'not available' : `+${(incident.quotaDelta5h * 100).toFixed(1)} percentage points`}**

${alertLines}

### Detector evidence

${Object.entries(incident.signals || {}).map(([key, value]) => `- ${key}: ${typeof value === 'number' ? value.toFixed(2) : value}`).join('\n') || '- No advanced detector evidence recorded'}

### 30-minute bootstrap forecast

${forecast ? `Median fresh input: **${compact(forecast.p50)} tokens**; conservative p90: **${compact(forecast.p90)} tokens**.` : 'Insufficient five-minute slices; at least three are required.'}

## Recent turns

| Time (UTC) | Cache hit | Uncached input | Cache read | Cache write | Output | Cost | Signals |
|---|---:|---:|---:|---:|---:|---:|---|
${turnRows}

## Five-minute slices

| Slice (UTC) | Calls | Cache hit | Fresh input | Cache write | Output |
|---|---:|---:|---:|---:|---:|
${sliceRows}

## Detector configuration

- Cache miss threshold: ${config.cacheMissPercent}%
- Cache cliff threshold: ${config.cacheCliffPoints} percentage points
- Large fresh-input threshold: ${config.largeFreshTokens} tokens
- Robust anomaly threshold: ${config.robustZThreshold}

## Immediate actions

1. Stop submitting prompts until cache state and the five-hour allowance are checked.
2. Check for model switches, long idle gaps, automatic compaction, subagents, retry loops, and unusually large tool results.
3. If the cache collapsed, save necessary context before starting a clean session.
4. Compare this incident with preceding five-minute slices before resuming.

## Interpretation caveat

Measurements come from local Claude Code transcripts. Cost uses Claude Code's per-entry costUSD when available and otherwise an official-price token estimate. It is API-equivalent impact—not Claude Max billing and not a conversion to five-hour subscription quota.
`;
}

module.exports = { generateReport };
