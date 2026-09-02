'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDashboard } = require('../src/dashboard');

test('dashboard renders metrics, controls, chart, and escaped anomaly evidence', () => {
  const turn = { timestamp: Date.now(), risk: 'critical', riskScore: 94, cacheHit: 8, fresh: 120000, alerts: [{ text: '<cache collapse>' }] };
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
  assert.match(html, /&lt;cache collapse&gt;/);
  assert.doesNotMatch(html, /<cache collapse>/);
});

test('dashboard offers one-click usage connection when OAuth data is unavailable', () => {
  const html = buildDashboard({ turns: [], slices: [], quotaSnapshots: [] }, { provider: 'unknown', quotaEnabled: true, cspSource: 'vscode-resource:', nonce: 'test' });
  assert.match(html, /Waiting to connect/);
  assert.match(html, /Connect live usage/);
});
