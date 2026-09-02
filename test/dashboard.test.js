'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDashboard, timeline24h, clusterIncidents } = require('../src/dashboard');

test('dashboard renders metrics, controls, chart, and escaped anomaly evidence', () => {
  const turn = { timestamp: Date.now(), risk: 'critical', riskScore: 94, cacheHit: 8, fresh: 120000, costUsd: 1.25, alerts: [{ code: 'CACHE_COLLAPSE', text: '<cache collapse>' }] };
  const state = {
    turns: [turn],
    slices: [{ start: Date.now(), calls: 2, fresh: 120000, cacheHit: 8 }],
    quotaSnapshots: [{ timestamp: Date.now(), utilization5h: 0.45, utilization7d: 0.62 }]
  };
  const html = buildDashboard(state, { provider: 'claude-ai', quotaEnabled: true, refreshIntervalSeconds: 15, cspSource: 'vscode-resource:', nonce: 'test' });
  assert.match(html, /5h:45% 7d:62%/);
  assert.match(html, /Cache hit/);
  assert.match(html, /Refresh every 15s/);
  assert.match(html, /Fresh input · last 24 hours/);
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
