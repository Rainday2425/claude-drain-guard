'use strict';

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function usageFromEntry(entry) {
  const usage = entry?.message?.usage || entry?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const cacheRead = number(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens);
  const creation = usage.cache_creation || usage.cacheCreation || {};
  const cacheWrite5m = number(creation.ephemeral_5m_input_tokens ?? creation.ephemeral5mInputTokens);
  const cacheWrite1h = number(creation.ephemeral_1h_input_tokens ?? creation.ephemeral1hInputTokens);
  const detailedCacheWrite = cacheWrite5m + cacheWrite1h;
  const cacheWrite = number(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens) || detailedCacheWrite;
  const input = number(usage.input_tokens ?? usage.inputTokens);
  const output = number(usage.output_tokens ?? usage.outputTokens);
  const reportedCost = Number(entry?.costUSD ?? entry?.cost_usd ?? entry?.message?.costUSD ?? (Number.isFinite(Number(entry?.cost_usd_micros)) ? Number(entry.cost_usd_micros) / 1_000_000 : undefined));
  const totalInput = input + cacheRead + cacheWrite;
  return {
    id: entry?.message?.id || entry?.requestId || entry?.uuid || null,
    timestamp: Date.parse(entry?.timestamp || '') || Date.now(),
    model: entry?.message?.model || entry?.model || 'unknown',
    speed: entry?.speed || entry?.message?.speed || 'normal',
    isSidechain: Boolean(entry?.isSidechain ?? entry?.is_sidechain),
    reportedCostUsd: Number.isFinite(reportedCost) && reportedCost >= 0 ? reportedCost : null,
    cacheRead,
    cacheWrite,
    cacheWrite5m,
    cacheWrite1h,
    input,
    output,
    fresh: input + cacheWrite,
    totalInput,
    cacheHit: totalInput > 0 ? (cacheRead / totalInput) * 100 : 100
  };
}

function sliceStart(timestamp, minutes = 5) {
  const width = minutes * 60_000;
  return Math.floor(timestamp / width) * width;
}

function mergeSlice(slice, usage, minutes = 5) {
  const start = sliceStart(usage.timestamp, minutes);
  const next = slice?.start === start ? { ...slice } : {
    start, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0, fresh: 0
  };
  next.calls += 1;
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h', 'fresh']) next[key] = (next[key] || 0) + (usage[key] || 0);
  const denominator = next.input + next.cacheRead + next.cacheWrite;
  next.cacheHit = denominator ? (next.cacheRead / denominator) * 100 : 100;
  return next;
}

module.exports = { usageFromEntry, sliceStart, mergeSlice };
