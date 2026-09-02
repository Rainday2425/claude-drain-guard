'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { usageFromEntry, mergeSlice } = require('../src/metrics');
const { analyzeTurn, robustScore, pageHinkley, cusum, bootstrapForecast, transitionAlertState } = require('../src/detector');
const { generateReport } = require('../src/report');
const { parseOAuthUsage, parseQuotaHeaders, quotaDelta } = require('../src/quota');

const config = { cacheMissPercent: 60, cacheCliffPoints: 40, largeFreshTokens: 100000, robustZThreshold: 4.5, absoluteCacheFloorPercent: 10 };

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

test('8% cache collapse is critical while 20% is not an arbitrary hard cutoff', () => {
  const history = [94, 96, 95, 97, 94, 96, 95].map((cacheHit, index) => ({ cacheHit, fresh: 4000 + index, cacheWrite: 1000, output: 500 }));
  const collapse = analyzeTurn({ cacheHit: 8, totalInput: 30000, fresh: 27600, cacheWrite: 3000, output: 500 }, history.at(-1), history, config);
  assert.equal(collapse.risk, 'critical');
  assert.ok(collapse.score >= 90);
  const coldButNotFloor = analyzeTurn({ cacheHit: 18, totalInput: 30000, fresh: 24600, cacheWrite: 3000, output: 500 }, null, [], config);
  assert.equal(coldButNotFloor.alerts.some(alert => alert.code === 'CACHE_COLLAPSE'), false);
});

test('96% cache with normal token activity is healthy', () => {
  const history = [95, 96, 97, 95, 96, 97, 95].map(cacheHit => ({ cacheHit, fresh: 4000, cacheWrite: 500, output: 400 }));
  const result = analyzeTurn({ cacheHit: 96, totalInput: 100000, fresh: 4000, cacheWrite: 500, output: 400 }, history.at(-1), history, config);
  assert.equal(result.risk, 'healthy');
  assert.equal(result.signals.cacheDeficit, 0);
  assert.equal(result.alerts.length, 0);
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
  assert.equal(state.level, 'warning');
  state = transitionAlertState(state, 'healthy', 3);
  assert.equal(state.level, 'healthy');
});

test('Page-Hinkley emits a change point once and resets its segment', () => {
  let state = {}, event;
  for (const value of [1000, 1100, 900, 1050, 950, 1000, 20000, 22000]) {
    event = pageHinkley(value, state);
    state = event.state;
    if (event.changed) break;
  }
  assert.equal(event.changed, true);
  assert.equal(state.count, 0);
  assert.equal(pageHinkley(1000, state).changed, false);
});

test('parses the read-only OAuth usage endpoint format', () => {
  const usage = parseOAuthUsage({
    five_hour: { utilization: 96, resets_at: '2026-09-02T20:00:00Z' },
    seven_day: { utilization: 0.42, resets_at: 2000000000 }
  }, 123);
  assert.equal(usage.utilization5h, 0.96);
  assert.equal(usage.utilization7d, 0.42);
  assert.equal(usage.timestamp, 123);
  assert.equal(usage.source, 'oauth-usage');
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
