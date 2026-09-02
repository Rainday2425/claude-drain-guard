'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateTurnCost, costSource, modelFamily } = require('../src/cost');

test('auto cost mode prefers Claude Code reported cost', () => {
  const turn = { reportedCostUsd: 2.5, model: 'claude-sonnet-4-6', input: 999999 };
  assert.equal(estimateTurnCost(turn), 2.5);
  assert.equal(costSource(turn), 'reported');
});

test('fallback estimate prices 5m and 1h cache creation separately', () => {
  const turn = { model: 'claude-sonnet-4-6', input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 2_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 };
  assert.equal(estimateTurnCost(turn), 28.05);
  assert.equal(costSource(turn), 'estimated');
});

test('legacy opus price and unknown model handling are explicit', () => {
  assert.equal(modelFamily('claude-opus-4-1-20250805'), 'opusLegacy');
  assert.equal(modelFamily('claude-sonnet-5'), 'sonnet5');
  assert.equal(estimateTurnCost({ model: 'claude-sonnet-5', input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }), 12);
  assert.equal(estimateTurnCost({ model: 'unknown', input: 100 }), null);
  assert.equal(estimateTurnCost({ model: 'claude-sonnet-4-6', input: 1_000_000 }, '5m', 'aws-bedrock'), null);
  assert.equal(estimateTurnCost({ model: 'claude-sonnet-4-6', speed: 'fast', input: 1_000_000 }), null);
});
