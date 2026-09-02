'use strict';

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quantile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index), upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function robustScore(value, history) {
  if (history.length < 6) return 0;
  const center = median(history);
  const mad = median(history.map(item => Math.abs(item - center)));
  return (value - center) / Math.max(1, mad * 1.4826);
}

function ewma(values, alpha = 0.35) {
  if (!values.length) return 0;
  return values.slice(1).reduce((mean, value) => alpha * value + (1 - alpha) * mean, values[0]);
}

function pageHinkley(value, previous = {}, options = {}) {
  const delta = options.delta ?? 0.03, threshold = options.threshold ?? 1.8;
  const x = Math.log1p(Math.max(0, value));
  const count = (previous.count || 0) + 1;
  const mean = (previous.mean || 0) + (x - (previous.mean || 0)) / count;
  const cumulative = (previous.cumulative || 0) + x - mean - delta;
  const minimum = Math.min(previous.minimum ?? 0, cumulative);
  const statistic = cumulative - minimum;
  const changed = count >= 6 && statistic > threshold;
  // A change point is an event, not a permanent state. Start a fresh segment
  // after emitting it so every later healthy turn is not reported as critical.
  const state = changed ? { count: 0, mean: 0, cumulative: 0, minimum: 0 } : { count, mean, cumulative, minimum };
  return { state, statistic, changed };
}

function cusum(z, previous = 0, drift = 0.5, threshold = 5) {
  const statistic = Math.max(0, previous + Math.max(0, z) - drift);
  const changed = statistic >= threshold;
  // As with Page-Hinkley, emit an event and start a new segment. Keeping an
  // alarmed cumulative value made every later turn look anomalous.
  return { value: changed ? 0 : statistic, statistic, changed };
}

function multivariateRisk(signals) {
  const raw = 0.25 * Math.min(10, Math.max(0, signals.freshZ)) +
    0.15 * Math.min(6, Math.max(0, signals.writeZ)) +
    0.10 * Math.min(5, Math.max(0, signals.outputZ)) +
    0.15 * Math.min(4, Math.max(0, signals.cacheDeficit)) +
    0.15 * Math.min(4, Math.max(0, signals.cacheCliff)) +
    0.20 * Math.min(8, Math.max(0, signals.cacheDropZ)) +
    (signals.pageHinkley ? 1.2 : 0) + (signals.cusum ? 1.0 : 0);
  return Math.min(100, 100 * (1 - Math.exp(-raw / 3)));
}

function bootstrapForecast(values, periods = 6, samples = 400) {
  if (values.length < 3) return null;
  let seed = values.reduce((sum, value, index) => (sum + Math.round(value) * (index + 1)) >>> 0, 2166136261);
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
  const totals = [];
  for (let i = 0; i < samples; i++) {
    let total = 0;
    for (let j = 0; j < periods; j++) total += values[Math.floor(random() * values.length)];
    totals.push(total);
  }
  return { p50: quantile(totals, 0.5), p90: quantile(totals, 0.9), periods };
}

function analyzeTurn(turn, previousTurn, history, config, online = {}) {
  const recent = history.slice(-72);
  const freshHistory = recent.map(item => item.fresh), writeHistory = recent.map(item => item.cacheWrite), outputHistory = recent.map(item => item.output);
  const cacheHistory = recent.map(item => item.cacheHit);
  const freshZ = robustScore(turn.fresh, freshHistory), writeZ = robustScore(turn.cacheWrite, writeHistory), outputZ = robustScore(turn.output, outputHistory);
  const cacheDropZ = robustScore(-turn.cacheHit, cacheHistory.map(value => -value));
  const ph = pageHinkley(turn.fresh, online.pageHinkley), cs = cusum(freshZ, online.cusum);
  const cliffPoints = previousTurn ? Math.max(0, previousTurn.cacheHit - turn.cacheHit) : 0;
  const cacheBaseline = median(cacheHistory);
  const excessFresh = turn.totalInput * Math.max(0, cacheBaseline - turn.cacheHit) / 100;
  const signals = { freshZ, writeZ, outputZ, cacheDropZ, excessFresh, cacheDeficit: Math.max(0, (80 - turn.cacheHit) / 20), cacheCliff: cliffPoints / Math.max(1, config.cacheCliffPoints), pageHinkley: ph.changed, cusum: cs.changed };
  let score = multivariateRisk(signals); const alerts = [];
  if (turn.totalInput >= 10_000 && cliffPoints >= config.cacheCliffPoints) alerts.push({ severity: 'critical', code: 'CACHE_CLIFF', text: `Cache ${previousTurn.cacheHit.toFixed(0)}%→${turn.cacheHit.toFixed(0)}% · ${compact(turn.fresh)} uncached` });
  const baselineCollapse = cacheHistory.length >= 6 && cacheBaseline - turn.cacheHit >= config.cacheCliffPoints && cacheDropZ >= config.robustZThreshold;
  const coldStartCollapse = cacheHistory.length < 6 && turn.cacheHit <= (config.absoluteCacheFloorPercent ?? 10);
  if (turn.totalInput >= 10_000 && (baselineCollapse || coldStartCollapse) && !alerts.some(alert => alert.code === 'CACHE_CLIFF')) {
    const uncached = baselineCollapse ? excessFresh : turn.fresh;
    alerts.push({ severity: 'critical', code: 'CACHE_COLLAPSE', text: `Cache collapsed to ${turn.cacheHit.toFixed(0)}% · ${compact(uncached)} uncached` });
  }
  if (turn.cacheHit < config.cacheMissPercent && turn.totalInput >= 10_000 && !alerts.some(alert => alert.code.startsWith('CACHE_'))) alerts.push({ severity: 'warning', code: 'CACHE_MISS', text: `Cache hit ${turn.cacheHit.toFixed(0)}%` });
  if (turn.fresh >= config.largeFreshTokens) alerts.push({ severity: 'critical', code: 'FRESH_SPIKE', text: `${compact(turn.fresh)} fresh input` });
  else if (freshZ >= config.robustZThreshold) alerts.push({ severity: 'warning', code: 'ROBUST_SPIKE', text: `Fresh input unusually high for this workload` });
  else if (ph.changed) alerts.push({ severity: 'warning', code: 'CHANGE_POINT', text: `Fresh-input pattern shifted` });
  else if (cs.changed) alerts.push({ severity: 'warning', code: 'CUSUM', text: `Fresh-input drift detected` });
  if (recent.length >= 6 && score >= 50 && !alerts.length) alerts.push({ severity: 'warning', code: 'MULTIVARIATE', text: `Combined anomaly ${score.toFixed(0)}/100` });
  const baseline = median(freshHistory), recentEwma = ewma([...freshHistory.slice(-5), turn.fresh]);
  if (!alerts.length && freshHistory.length >= 6 && baseline > 0 && recentEwma >= baseline * 3) alerts.push({ severity: 'warning', code: 'BURN_ACCELERATION', text: 'Recent burn is >3× baseline' });
  if (alerts.some(alert => alert.severity === 'critical')) score = Math.max(90, score);
  else if (alerts.length) score = Math.max(55, score);
  return { alerts, score, signals, baseline, recentEwma, online: { pageHinkley: ph.state, cusum: cs.value }, risk: alerts.some(a => a.severity === 'critical') ? 'critical' : alerts.length ? 'warning' : 'healthy' };
}

function transitionAlertState(previous = {}, risk, now = Date.now()) {
  const healthyStreak = risk === 'healthy' ? (previous.healthyStreak || 0) + 1 : 0;
  let level = previous.level || 'healthy';
  if (risk === 'critical') level = 'critical';
  else if (risk === 'warning') level = 'warning';
  else if (risk === 'healthy' && level === 'critical') level = 'warning';
  else if (healthyStreak >= 2) level = 'healthy';
  const shouldNotify = risk !== 'healthy' && (risk !== previous.lastNotifiedRisk || now - (previous.lastNotifiedAt || 0) >= 5 * 60_000);
  return { level, healthyStreak, lastNotifiedRisk: shouldNotify ? risk : previous.lastNotifiedRisk, lastNotifiedAt: shouldNotify ? now : previous.lastNotifiedAt, shouldNotify };
}

function compact(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(Math.round(value));
}

module.exports = { median, quantile, robustScore, ewma, pageHinkley, cusum, multivariateRisk, bootstrapForecast, analyzeTurn, transitionAlertState, compact };
