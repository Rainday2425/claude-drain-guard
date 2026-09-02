'use strict';

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function usageFromEntry(entry) {
  const usage = entry?.message?.usage || entry?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const cacheRead = number(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens);
  const cacheWrite = number(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens);
  const input = number(usage.input_tokens ?? usage.inputTokens);
  const output = number(usage.output_tokens ?? usage.outputTokens);
  const totalInput = input + cacheRead + cacheWrite;
  return {
    id: entry?.message?.id || entry?.requestId || entry?.uuid || null,
    timestamp: Date.parse(entry?.timestamp || '') || Date.now(),
    model: entry?.message?.model || entry?.model || 'unknown',
    cacheRead,
    cacheWrite,
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
    start, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, fresh: 0
  };
  next.calls += 1;
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'fresh']) next[key] += usage[key];
  const denominator = next.input + next.cacheRead + next.cacheWrite;
  next.cacheHit = denominator ? (next.cacheRead / denominator) * 100 : 100;
  return next;
}

module.exports = { usageFromEntry, sliceStart, mergeSlice };
