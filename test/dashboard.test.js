'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDashboard, timeline24h, currentSession, clusterIncidents } = require('../src/dashboard');

test('dashboard renders metrics, controls, chart, and escaped anomaly evidence', () => {
  const turn = { timestamp: Date.now(), sessionId: 'session-1', project: 'my-app', risk: 'critical', riskScore: 94, cacheHit: 8, fresh: 120000, totalInput: 130000, cacheRead: 10000, output: 500, costUsd: 1.25, alerts: [{ code: 'CACHE_COLLAPSE', text: '<cache collapse>' }] };
  const state = {
    turns: [turn],
    slices: [{ start: Date.now(), calls: 2, fresh: 120000, cacheHit: 8 }],
    quotaSnapshots: [{ timestamp: Date.now(), utilization5h: 0.45, utilization7d: 0.62 }]
  };
  const html = buildDashboard(state, { provider: 'claude-ai', quotaEnabled: true, refreshIntervalSeconds: 15, cspSource: 'vscode-resource:', nonce: 'test', sessions: [{ sessionId: 'session-1', project: 'my-app', lastActivity: Date.now() }] });
  assert.match(html, /5h:45% 7d:62%/);
  assert.match(html, /Cache hit/);
  assert.match(html, /Refresh every 15s/);
  assert.match(html, /Fresh input · last 24 hours/);
  assert.match(html, /Ongoing session/);
  assert.match(html, /Each bar is one completed API response/);
  assert.match(html, /data-tooltip=/);
  assert.match(html, /total fresh/);
  assert.match(html, /Recent incidents/);
  assert.match(html, /API-equivalent · 24h/);
  assert.match(html, /data-bucket="5"/);
  assert.match(html, /data-bucket="30"/);
  assert.match(html, /data-bucket="60"/);
  assert.match(html, /Cache collapse/);
  assert.doesNotMatch(html, /<cache collapse>/);
});

test('dashboard offers one-click usage connection when OAuth data is unavailable', () => {
  const html = buildDashboard({ turns: [], slices: [], quotaSnapshots: [] }, { provider: 'unknown', quotaEnabled: true, cspSource: 'vscode-resource:', nonce: 'test' });
  assert.match(html, /Waiting to connect/);
  assert.match(html, /Connect live usage/);
});

test('24-hour timeline contains real five-minute wall-clock gaps', () => {
  const width = 5 * 60_000;
  const now = Date.UTC(2026, 8, 2, 12, 3);
  const end = Math.floor(now / width) * width;
  const timeline = timeline24h([{ start: end, fresh: 42, calls: 1, cacheHit: 96 }], [], now);
  assert.equal(timeline.length, 288);
  assert.equal(timeline.at(-1).fresh, 42);
  assert.equal(timeline.at(-2).fresh, 0);
  assert.equal(timeline[1].start - timeline[0].start, width);
});

test('timeline falls back to current-session turns before a slice is present', () => {
  const width = 5 * 60_000;
  const now = Date.UTC(2026, 8, 2, 12, 3);
  const timeline = timeline24h([], [{ timestamp: now, fresh: 42000, totalInput: 100000, cacheRead: 80000, cacheHit: 80, risk: 'healthy' }], now);
  assert.equal(timeline.at(-1).fresh, 42000);
  assert.equal(timeline.at(-1).calls, 1);
  assert.equal(timeline.at(-1).cacheHit, 80);
  assert.equal(timeline.at(-1).start, Math.floor(now / width) * width);
});

test('current session aggregates only the active JSONL session', () => {
  const now = Date.UTC(2026, 8, 2, 12);
  const turns = [
    { sessionId: 'old', timestamp: now - 60_000, fresh: 999, totalInput: 1000, cacheRead: 1, output: 1 },
    { sessionId: 'live', project: 'app', timestamp: now - 30_000, fresh: 100, totalInput: 1000, cacheRead: 900, output: 20, costUsd: 0.1 },
    { sessionId: 'live', project: 'app', timestamp: now, fresh: 200, totalInput: 1000, cacheRead: 800, output: 30, costUsd: 0.2 }
  ];
  const session = currentSession(turns, [{ sessionId: 'live', project: 'app', lastActivity: now }], now);
  assert.equal(session.active, true);
  assert.equal(session.responses, 2);
  assert.equal(session.fresh, 300);
  assert.equal(session.output, 50);
  assert.equal(session.cacheHit, 85);
  assert.ok(Math.abs(session.cost - 0.3) < 1e-9);
});

test('current session associates contiguous legacy turns without replaying files', () => {
  const now = Date.UTC(2026, 8, 2, 12);
  const turns = [
    { project: 'app', timestamp: now - 2 * 60 * 60_000, fresh: 900, totalInput: 1000, cacheRead: 100 },
    { project: 'app', timestamp: now - 4 * 60_000, fresh: 100, totalInput: 1000, cacheRead: 900 },
    { project: 'app', timestamp: now - 60_000, fresh: 200, totalInput: 1000, cacheRead: 800 }
  ];
  const session = currentSession(turns, [{ sessionId: 'live-file', project: 'app', lastActivity: now }], now);
  assert.equal(session.responses, 2);
  assert.equal(session.fresh, 300);
});

test('consecutive anomaly turns are grouped and healthy turns split incidents', () => {
  const base = Date.UTC(2026, 8, 2, 12);
  const alert = { code: 'FRESH_SPIKE', text: 'large' };
  const incidents = clusterIncidents([
    { timestamp: base, risk: 'critical', cacheHit: 8, fresh: 500000, costUsd: 2, alerts: [alert] },
    { timestamp: base + 60_000, risk: 'critical', cacheHit: 7, fresh: 400000, costUsd: 1, alerts: [alert] },
    { timestamp: base + 2 * 60_000, risk: 'healthy', cacheHit: 96, fresh: 1000, alerts: [] },
    { timestamp: base + 3 * 60_000, risk: 'warning', cacheHit: 70, fresh: 2000, alerts: [{ code: 'CACHE_MISS' }] }
  ]);
  assert.equal(incidents.length, 2);
  assert.equal(incidents[0].turns, 2);
  assert.equal(incidents[0].totalFresh, 900000);
  assert.equal(incidents[0].cost, 3);
  assert.equal(incidents[1].risk, 'warning');
});
