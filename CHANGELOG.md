# Changelog

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
