'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function readAccessToken(credentialsPath, env = process.env) {
  const injected = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (injected) return injected;
  const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  const oauth = parsed?.claudeAiOauth;
  if (!oauth?.accessToken) throw new Error('OAuth access token not found');
  if (oauth.expiresAt && oauth.expiresAt <= Date.now()) throw new Error('OAuth access token has expired; run claude login');
  return oauth.accessToken;
}

function normalizeUtilization(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number > 1 ? number / 100 : number;
}

function parseReset(value) {
  if (typeof value === 'number') return value > 10_000_000_000 ? value : value * 1000;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseOAuthUsage(payload, now = Date.now()) {
  const five = normalizeUtilization(payload?.five_hour?.utilization);
  if (five === null) throw new Error('Anthropic usage response did not include five_hour.utilization');
  const seven = normalizeUtilization(payload?.seven_day?.utilization);
  return {
    timestamp: now,
    utilization5h: five,
    utilization7d: seven,
    reset5hAt: parseReset(payload.five_hour?.resets_at),
    reset7dAt: parseReset(payload.seven_day?.resets_at),
    status: payload.five_hour?.status || (five >= 1 ? 'denied' : 'allowed'),
    source: 'oauth-usage'
  };
}

function parseQuotaHeaders(headers, now = Date.now()) {
  const get = name => headers.get(name);
  const five = Number.parseFloat(get('anthropic-ratelimit-unified-5h-utilization') || 'NaN');
  if (!Number.isFinite(five)) throw new Error('Anthropic response did not include unified 5h headers');
  const sevenRaw = get('anthropic-ratelimit-unified-7d-utilization');
  const reset5 = Number.parseInt(get('anthropic-ratelimit-unified-5h-reset') || '0', 10);
  const reset7 = Number.parseInt(get('anthropic-ratelimit-unified-7d-reset') || '0', 10);
  return {
    timestamp: now,
    utilization5h: five,
    utilization7d: sevenRaw === null ? null : Number.parseFloat(sevenRaw),
    reset5hAt: reset5 > 0 ? reset5 * 1000 : 0,
    reset7dAt: reset7 > 0 ? reset7 * 1000 : 0,
    status: get('anthropic-ratelimit-unified-5h-status') || 'unknown'
  };
}

async function fetchQuota(options) {
  const token = readAccessToken(options.credentialsPath);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 10_000);
  try {
    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`Anthropic usage request failed (${response.status})`);
    return parseOAuthUsage(await response.json());
  } finally { clearTimeout(timer); }
}

function quotaDelta(previous, current) {
  if (!previous || !current || previous.reset5hAt !== current.reset5hAt) return null;
  const delta = current.utilization5h - previous.utilization5h;
  return delta >= 0 ? delta : null;
}

function rolloverQuota(snapshot, now = Date.now()) {
  if (!snapshot?.reset5hAt || now < snapshot.reset5hAt || snapshot.source === 'local-window-reset') return snapshot;
  return {
    ...snapshot,
    timestamp: now,
    utilization5h: 0,
    reset5hAt: 0,
    delta5h: null,
    status: 'allowed',
    source: 'local-window-reset'
  };
}

function defaultCredentials(dataDirectory, configured = '') {
  if (configured) return configured;
  const candidates = [
    path.join(dataDirectory, '.credentials.json'),
    path.join(os.homedir(), '.claude', '.credentials.json'),
    path.join(os.homedir(), '.config', 'claude', '.credentials.json'),
    path.join(os.homedir(), '.config', 'claude-code', '.credentials.json')
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}

module.exports = { readAccessToken, normalizeUtilization, parseReset, parseOAuthUsage, parseQuotaHeaders, fetchQuota, quotaDelta, rolloverQuota, defaultCredentials };
