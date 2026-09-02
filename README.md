# Claude Drain Guard

![SAFE, WATCH, and STOP status-bar states](images/states.png)

A zero-dependency VS Code extension that watches Claude Code locally, aggregates five-minute slices, and tells you to stop after the first anomalous prompt—before the next few prompts drain the session.

## Status bar

One progressive status item keeps healthy sessions quiet and makes danger obvious:

- Healthy: `5h 31% · Cache 97%`
- Warning: `WATCH · Cache 54%`
- Critical: `STOP · 5h +5.1%`

## Signals

- Per-turn cache hit and fresh-token spike
- Cache cliff (large hit-rate drop between turns)
- Median/MAD robust anomaly score, resistant to outliers
- Short EWMA acceleration against the user's own rolling baseline
- Page-Hinkley change points and one-sided CUSUM for sustained drain
- Multivariate risk scoring across fresh input, cache write, output, cache deficit and cache cliffs
- Baselines segmented by model, project, context bucket and cache state
- Deterministic bootstrap 30-minute burn forecast with p50/p90 bounds
- Hysteresis and notification cooldown to suppress alert flapping
- Compact status bar: `5m fresh tokens · cache hit · risk score`
- Progressive-disclosure status bar with separate `SAFE/WATCH/STOP`, five-hour gauge, and cache items
- Markdown hover card that leads with action, then a signal table and explanations
- Acknowledgement-required critical alert after the first anomalous turn
- Automatic local Markdown incident report with recent turns and five-minute slices

No prompts, source code, credentials, or telemetry are collected. Local monitoring is the default. In v0.4, users may explicitly opt in to an authoritative quota adapter: it reads the existing Claude OAuth token in memory, makes at most one minimal 1-token Haiku request per five minutes after local Claude activity, reads only rate-limit response headers, never persists the token, and falls back safely to local detection on failure. This optional request consumes a tiny amount of quota.

![Critical drain hover with evidence](images/incident.png)

## Development

Open this folder in VS Code and press `F5`. Run `node --test test/*.test.js` for the detector tests.

## Commands

- `Claude Drain Guard: Show Details`
- `Claude Drain Guard: Generate Incident Report`
- `Claude Drain Guard: Mute Alerts for 15 Minutes`
- `Claude Drain Guard: Reset Baseline`

## Privacy and security

See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md). This is a community project and is not affiliated with or endorsed by Anthropic.
