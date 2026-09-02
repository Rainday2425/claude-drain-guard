'use strict';

const fs = require('fs');
const path = require('path');

function readAccessToken(credentialsPath) {
  const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  const oauth = parsed?.claudeAiOauth;
  if (!oauth?.accessToken) throw new Error('OAuth access token not found');
  if (oauth.expiresAt && oauth.expiresAt <= Date.now()) throw new Error('OAuth access token has expired; run claude login');
  return oauth.accessToken;
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
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: '.' }] })
    });
    // Rate-limit headers can be useful even when the body reports an error.
    return parseQuotaHeaders(response.headers);
  } finally { clearTimeout(timer); }
}

function quotaDelta(previous, current) {
  if (!previous || !current || previous.reset5hAt !== current.reset5hAt) return null;
  const delta = current.utilization5h - previous.utilization5h;
  return delta >= 0 ? delta : null;
}

function defaultCredentials(dataDirectory, configured = '') {
  return configured || path.join(dataDirectory, '.credentials.json');
}

module.exports = { readAccessToken, parseQuotaHeaders, fetchQuota, quotaDelta, defaultCredentials };
