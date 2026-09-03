# Changelog

## 0.8.4

- Added an Ongoing session card keyed by the active Claude JSONL session, with totals and one bar per completed API response.
- Added exact token/cache/output/cost hover data to session bars and exact bucket data to the 24-hour chart.
- Added numeric chart scale labels plus total and peak values so bars are not decorative-only.
- Server-rendered the initial 5-minute bars so the chart remains populated even before its Webview script runs.
- Backfilled missing current buckets directly from turns when a five-minute slice has not been written yet.
- Associated records saved by earlier versions with the latest contiguous project run without replaying or duplicating historical data.

## 0.8.3

- Grouped consecutive anomalous turns into incidents so one drain episode produces one dashboard row.
- Added selectable 5-minute, 30-minute, and 1-hour chart buckets on a true 24-hour wall-clock timeline.
- Switched the chart to a log scale and marked warning/critical buckets without flattening normal activity.
- Made Page-Hinkley, CUSUM, robust, and multivariate-only changes elevated rather than critical; absolute cache collapse or high fresh input is still critical.
- Reset CUSUM after a detected change point to stop repeated alerts from a latched statistic.
- Added `costUSD`-first API-equivalent cost tracking with official per-model fallback pricing and separate 5m/1h cache-write tokens.
- Added cost impact to the dashboard, grouped incidents, and generated reports while explicitly separating it from Max billing and 5h quota.

## 0.8.2

- Fixed a recovered 96% cache-hit turn remaining visually critical because of alert-state stickiness.
- Reset Page-Hinkley after each detected change point to prevent repeated critical reports.
- Switched live limits to the read-only OAuth usage endpoint, which sends no model prompt.
- Added a zero-request fallback that observes the official Claude Code extension's usage response when its OAuth token is not readable.

## 0.8.1

- Published the finalized dashboard, default live 5h/7d usage, and corrected cache-collapse scoring as a new immutable Marketplace version.

## 0.8.0

- Added adaptive Claude.ai 5h/7d, 5h-only, stale, local, API-key, and Bedrock status formats.
- Enabled live 5h/7d sampling by default, matching the reference extension, with a local-only opt-out.
- Kept cache hit visible in every active status format.
- Kept quota percentages informational: only drain-anomaly signals control the blue/yellow/red indicator.
- Avoided inaccurate dollar estimates when the active model's pricing is unknown.
- Added a native-themed dashboard with 24-hour five-minute slices and recent anomalies.
- Fixed cache-state self-segmentation so a warm-to-cold collapse is compared with the user's real baseline.
- Added robust cache-drop scoring, excess-fresh-token evidence, and a 90-point floor for critical signals.

## 0.7.1

- Fixed the right-side usage and state items not appearing before the first valid usage record.
- Added an explicit `5h — · cache —` idle state that renders immediately on activation.
- Matched the stable two-argument status-item creation pattern used by `vscode-claude-status`.

## 0.7.0

- Replaced repeated recursive scans with direct event-driven reads of changed JSONL files.
- Added asynchronous 256 KB streaming reads with safe incomplete-line offsets.
- Added an in-memory ID index and coalesced asynchronous atomic state writes.
- Added lightweight known-file refreshes from 1–60 seconds (15 seconds by default).
- Reduced full session discovery to one asynchronous reconciliation per minute.
- Kept five-hour usage and cache hit persistently visible in the compact right-side item.

## 0.6.2

- Reduced the persistent right-side status item to five-hour usage only.
- Added a separate blue dot for normal activity, yellow for elevated activity, and red `Alert` for critical drain.
- Kept cache and five-minute slice details in the hover and activity picker.

## 0.6.1

- Restyled the status item after Claude Code's compact, metric-first status-line pattern.
- Removed slogan-like SAFE/WATCH/STOP labels and all emoji-style presentation.
- Defaulted the workspace-wide item to the left side per VS Code UX guidance.

## 0.6.0

- Replaced three competing status items with one cohesive, progressive status item.
- Healthy state shows five-hour allowance and cache hit quietly.
- Warning and critical states replace metrics with clear WATCH and STOP actions.
- Redesigned the native Markdown hover and recent-activity Quick Pick.

## 0.5.2

- Added three progressive-disclosure status-bar items: SAFE/WATCH/STOP, five-hour quota, and prompt cache.
- Added Marketplace icon and screenshots.
- Removed Unicode quota meter for consistent Windows rendering.
- Added optional authoritative five-hour quota sampling and five-minute delta alerts.
- Added incident reports, Page-Hinkley, CUSUM, robust MAD scoring, segmented baselines, bootstrap forecasts, and alert hysteresis.

## 0.5.0

- Initial public Marketplace release.
