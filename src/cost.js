'use strict';

const PRICES = {
  haiku: { input: 1, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2, output: 5 },
  haikuLegacy: { input: 0.8, cacheRead: 0.08, cacheWrite5m: 1, cacheWrite1h: 1.6, output: 4 },
  sonnet: { input: 3, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6, output: 15 },
  sonnet5: { input: 2, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4, output: 10 },
  opus: { input: 5, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10, output: 25 },
  opusLegacy: { input: 15, cacheRead: 1.5, cacheWrite5m: 18.75, cacheWrite1h: 30, output: 75 },
  fable5: { input: 10, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20, output: 50 },
  fable51: { input: 10, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20, output: 50 }
};

function modelFamily(model = '') {
  const value = String(model).toLowerCase();
  if (/haiku-3-5|haiku-3\.5/.test(value)) return 'haikuLegacy';
  if (value.includes('haiku')) return 'haiku';
  if (/sonnet-5(?:-|$)/.test(value)) return 'sonnet5';
  if (value.includes('sonnet')) return 'sonnet';
  if (/opus-4-(0|1)(?:-|$)/.test(value)) return 'opusLegacy';
  if (value.includes('opus')) return 'opus';
  if (/(fable|mythos)-5-1(?:-|$)/.test(value)) return 'fable51';
  if (/(fable|mythos)-5(?:-|$)/.test(value)) return 'fable5';
  return null;
}

function estimateTurnCost(turn, fallbackTtl = '5m', provider = 'claude-ai') {
  if (Number.isFinite(turn?.reportedCostUsd) && turn.reportedCostUsd >= 0) return turn.reportedCostUsd;
  // First-party list prices are not a safe fallback for cloud-provider or
  // fast-mode requests. In those cases wait for Claude Code's own estimate.
  if (provider === 'aws-bedrock' || turn?.speed === 'fast') return null;
  const family = modelFamily(turn?.model);
  if (!family) return null;
  const price = PRICES[family];
  const cacheWrite5m = Number(turn.cacheWrite5m) || 0;
  const cacheWrite1h = Number(turn.cacheWrite1h) || 0;
  const unspecifiedWrite = Math.max(0, (Number(turn.cacheWrite) || 0) - cacheWrite5m - cacheWrite1h);
  const fallbackRate = fallbackTtl === '5m' ? price.cacheWrite5m : price.cacheWrite1h;
  return ((Number(turn.input) || 0) * price.input +
    (Number(turn.cacheRead) || 0) * price.cacheRead +
    cacheWrite5m * price.cacheWrite5m +
    cacheWrite1h * price.cacheWrite1h +
    unspecifiedWrite * fallbackRate +
    (Number(turn.output) || 0) * price.output) / 1_000_000;
}

function costSource(turn, provider = 'claude-ai') {
  return Number.isFinite(turn?.reportedCostUsd) && turn.reportedCostUsd >= 0 ? 'reported' : provider !== 'aws-bedrock' && turn?.speed !== 'fast' && modelFamily(turn?.model) ? 'estimated' : 'unavailable';
}

module.exports = { PRICES, modelFamily, estimateTurnCost, costSource };
