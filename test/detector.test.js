'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { usageFromEntry, mergeSlice } = require('../src/metrics');
const { analyzeTurn, robustScore, pageHinkley, cusum, bootstrapForecast, transitionAlertState } = require('../src/detector');
const { generateReport } = require('../src/report');
const { parseQuotaHeaders, quotaDelta } = require('../src/quota');

const config = { cacheMissPercent: 60, cacheCliffPoints: 40, largeFreshTokens: 100000, robustZThreshold: 4.5 };

test('extracts Claude usage and calculates cache hit', () => {
  const usage = usageFromEntry({ timestamp: '2026-01-01T00:00:00Z', message: { id: 'x', usage: { input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 100, output_tokens: 20 } } });
  assert.equal(usage.cacheHit, 80);
  assert.equal(usage.fresh, 200);
});

test('detects cache cliff and fresh spike', () => {
  const previous = { cacheHit: 98 };
  const turn = { cacheHit: 10, totalInput: 200000, fresh: 180000 };
  const result = analyzeTurn(turn, previous, [], config);
  assert.equal(result.risk, 'critical');
  assert.ok(result.alerts.some(a => a.code === 'CACHE_CLIFF'));
  assert.ok(result.alerts.some(a => a.code === 'FRESH_SPIKE'));
});

test('robust score ignores stable noise and flags spike', () => {
  assert.ok(robustScore(10000, [1000, 1050, 950, 1020, 980, 1010, 990]) > 20);
});

test('aggregates five-minute slices', () => {
  const a = mergeSlice(null, { timestamp: 1000, input: 10, output: 2, cacheRead: 80, cacheWrite: 10, fresh: 20 }, 5);
  const b = mergeSlice(a, { timestamp: 2000, input: 10, output: 2, cacheRead: 80, cacheWrite: 10, fresh: 20 }, 5);
  assert.equal(b.calls, 2);
  assert.equal(b.cacheHit, 80);
});

test('incident report contains evidence and response guidance', () => {
  const incident = { timestamp: 1, risk: 'critical', cacheHit: 5, fresh: 120000, cacheRead: 5000, cacheWrite: 110000, input: 10000, output: 300, alerts: [{ code: 'CACHE_CLIFF', text: 'Cache fell 90 points' }] };
  const report = generateReport(incident, [incident], [{ start: 0, calls: 1, cacheHit: 5, fresh: 120000, cacheWrite: 110000, output: 300 }], config);
  assert.match(report, /CACHE_CLIFF/);
  assert.match(report, /Stop submitting prompts/);
});

test('Page-Hinkley and CUSUM detect sustained distribution shift', () => {
  let ph = {}, changed = false;
  for (const value of [1000, 1100, 900, 1050, 950, 1000, 20000, 22000]) {
    const result = pageHinkley(value, ph);
    ph = result.state; changed ||= result.changed;
  }
  assert.equal(changed, true);
  let sum = 0;
  for (const z of [1.5, 1.5, 1.5, 1.5, 1.5]) sum = cusum(z, sum).value;
  assert.ok(sum >= 5);
});

test('bootstrap forecast is deterministic and hysteresis needs two healthy turns', () => {
  assert.deepEqual(bootstrapForecast([10, 20, 30]), bootstrapForecast([10, 20, 30]));
  let state = transitionAlertState({}, 'critical', 1);
  state = transitionAlertState(state, 'healthy', 2);
  assert.equal(state.level, 'critical');
  state = transitionAlertState(state, 'healthy', 3);
  assert.equal(state.level, 'healthy');
});

test('parses authoritative quota headers and rejects cross-window deltas', () => {
  const values = new Map([
    ['anthropic-ratelimit-unified-5h-utilization', '0.42'],
    ['anthropic-ratelimit-unified-7d-utilization', '0.18'],
    ['anthropic-ratelimit-unified-5h-reset', '2000'],
    ['anthropic-ratelimit-unified-7d-reset', '9000'],
    ['anthropic-ratelimit-unified-5h-status', 'allowed']
  ]);
  const current = parseQuotaHeaders({ get: key => values.has(key) ? values.get(key) : null }, 1000);
  assert.equal(current.utilization5h, 0.42);
  assert.ok(Math.abs(quotaDelta({ utilization5h: 0.39, reset5hAt: current.reset5hAt }, current) - 0.03) < 1e-9);
  assert.equal(quotaDelta({ utilization5h: 0.9, reset5hAt: 123 }, current), null);
});
