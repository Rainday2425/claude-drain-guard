'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { usageFromEntry, mergeSlice } = require('../src/metrics');

test('extracts official token fields, cache TTL detail, and reported cost', () => {
  const turn = usageFromEntry({ timestamp: '2026-09-02T12:00:00Z', costUSD: 1.23, message: { id: 'x', model: 'claude-sonnet-4-6', usage: {
    input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900,
    cache_creation_input_tokens: 300,
    cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 }
  } } });
  assert.equal(turn.cacheWrite5m, 100);
  assert.equal(turn.cacheWrite1h, 200);
  assert.equal(turn.reportedCostUsd, 1.23);
  assert.equal(turn.fresh, 400);
  assert.equal(turn.totalInput, 1300);
});

test('slice retains cache TTL token details', () => {
  const usage = { timestamp: Date.UTC(2026, 8, 2, 12), input: 10, output: 2, cacheRead: 80, cacheWrite: 10, cacheWrite5m: 4, cacheWrite1h: 6, fresh: 20 };
  const slice = mergeSlice(null, usage);
  assert.equal(slice.cacheWrite5m, 4);
  assert.equal(slice.cacheWrite1h, 6);
  assert.equal(slice.cacheHit, 80);
});
