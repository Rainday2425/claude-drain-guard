'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatStatus } = require('../src/display');

test('status formats 5h, optional 7d, stale age, and cache', () => {
  const now = 2_000_000;
  assert.equal(formatStatus({ quota: { utilization5h: 0.45, utilization7d: 0.62, timestamp: now }, cacheHit: 96.6, now }), '5h:45% 7d:62% · cache:97%');
  assert.equal(formatStatus({ quota: { utilization5h: 0.45, utilization7d: null, timestamp: now }, cacheHit: 96.6, now }), '5h:45% · cache:97%');
  assert.equal(formatStatus({ quota: { utilization5h: 0.45, utilization7d: null, timestamp: now - 11 * 60_000 }, cacheHit: 96.6, now }), '5h:45% [11m] · cache:97%');
});

test('local provider modes keep cache prominent', () => {
  assert.equal(formatStatus({ cacheHit: 91, sliceFresh: 12400, provider: 'api-key' }), 'cache:91% · 5m:12k');
  assert.equal(formatStatus({ cacheHit: 91, provider: 'unknown' }), 'cache:91% · local');
  assert.equal(formatStatus({ cacheHit: 91, provider: 'unknown', quotaEnabled: true }), 'cache:91% · offline');
});
