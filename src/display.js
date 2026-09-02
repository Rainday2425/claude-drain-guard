'use strict';

const fs = require('fs');
const path = require('path');
const { compact } = require('./detector');

function detectProvider(dataDirectory, credentialsPath = '', env = process.env) {
  const credential = credentialsPath || path.join(dataDirectory, '.credentials.json');
  if (fs.existsSync(credential)) return 'claude-ai';
  if (env.ANTHROPIC_BEDROCK_BASE_URL || env.AWS_BEDROCK_RUNTIME_URL || env.CLAUDE_AWS_REGION) return 'aws-bedrock';
  if (env.ANTHROPIC_API_KEY) return 'api-key';
  return 'unknown';
}

function ageLabel(timestamp, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatStatus({ quota, cacheHit, sliceFresh = 0, provider = 'unknown', quotaEnabled = false, now = Date.now() }) {
  const cache = Number.isFinite(cacheHit) ? `cache:${Math.round(cacheHit)}%` : 'cache:—';
  if (quota && Number.isFinite(quota.utilization5h)) {
    const parts = [`5h:${Math.round(quota.utilization5h * 100)}%`];
    if (Number.isFinite(quota.utilization7d)) parts.push(`7d:${Math.round(quota.utilization7d * 100)}%`);
    if (now - quota.timestamp > 10 * 60_000) parts.push(`[${ageLabel(quota.timestamp, now)}]`);
    return `${parts.join(' ')} · ${cache}`;
  }
  if (provider === 'aws-bedrock' || provider === 'api-key') return `${cache} · 5m:${compact(sliceFresh)}`;
  return quotaEnabled ? `5h:— · ${cache}` : `${cache} · local`;
}

module.exports = { detectProvider, ageLabel, formatStatus };
