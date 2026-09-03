# Claude Drain Guard

A zero-dependency VS Code extension that watches Claude Code locally, aggregates five-minute slices, and tells you to stop after the first anomalous prompt—before the next few prompts drain the session.

## Install or update

Install **Claude Drain Guard 0.8.4** from the Visual Studio Marketplace, or open **Extensions: Install from VSIX...** in VS Code and select the `0.8.4` VSIX package.

Marketplace releases are immutable: an uploaded package cannot be replaced. Use `0.8.4` for live-session visibility and data-bearing interactive charts.

## Status bar

Five-hour usage and cache hit stay visible in a small item on the right. A separate state indicator sits beside it:

- Normal: `5h 31% · cache 97%` followed by a blue dot
- Elevated: the same metrics followed by a yellow dot
- Critical: the same metrics followed by a red dot and `Alert`

Click the item and select **Refresh every Ns** to set a 1–60 second background refresh interval. The default is 15 seconds; file changes still trigger an immediate incremental read.

Quota display adapts to the available data: Claude.ai 5h/7d, 5h-only, stale quota, or local API/Bedrock usage. Cache hit remains visible in every active mode. The colored indicator is independent of the quota percentage: only cache, fresh-token, change-point, and sudden-drain anomaly signals change it.

## Signals

- Per-turn cache hit and fresh-token spike
- Cache cliff (large hit-rate drop between turns)
- Median/MAD robust anomaly score, resistant to outliers
- Short EWMA acceleration against the user's own rolling baseline
- Page-Hinkley change points and one-sided CUSUM for sustained drain
- Multivariate risk scoring across fresh input, cache write, output, cache deficit and cache cliffs
- Baselines segmented by model, project and context bucket, so a warm-to-cold cache collapse is compared with the correct historical workload
- Deterministic bootstrap 30-minute burn forecast with p50/p90 bounds
- Hysteresis and notification cooldown to suppress alert flapping
- Compact status bar: `5m fresh tokens · cache hit · risk score`
- Compact right-side usage item plus a tiny blue/yellow/red state indicator
- Compact native hover for the current slice; detailed evidence stays in VS Code Quick Pick
- Acknowledgement-required critical alert after the first anomalous turn
- Automatic local Markdown incident report with recent turns and five-minute slices
- Cost auto mode: prefer Claude Code's per-entry `costUSD`, then estimate from official model pricing when it is absent
- Separate 5-minute and 1-hour cache-write pricing when Claude Code provides the TTL breakdown

## Dashboard

Click the status item or run **Claude Drain Guard: Open Dashboard**. The first card is the current Claude Code session, detected from the most recently active JSONL session file. It shows session totals and one bar per completed API response. Hover a bar for its exact fresh input, cache hit, output, time, and cost. Records created by older releases are associated with the latest contiguous project run without rescanning or duplicating historical data.

The 24-hour chart switches between 5-minute, 30-minute, and 1-hour buckets and uses a log scale so ordinary activity remains visible beside a large spike. It includes numeric scale labels, total/peak values, and detailed hover data. The initial 5-minute bars are rendered before Webview JavaScript runs, and current-session turns backfill a bucket if its aggregate slice is not available yet. Consecutive anomalous turns are grouped into one incident with aggregate fresh tokens and cost instead of filling the table with repeated rows. Prompt and response content is never shown.

Cost follows the mature [ccusage auto strategy](https://github.com/ccusage/ccusage/blob/main/docs/guide/cost-modes.md): use Claude Code's reported per-entry estimate when available, otherwise multiply input, output, cache-read, 5-minute cache-write, and 1-hour cache-write tokens by the matching [official model rates](https://platform.claude.com/docs/en/about-claude/pricing). It is an API-equivalent impact estimate, not a Claude Max invoice and not a conversion to the 5-hour quota. If old records omit the TTL breakdown, the default fallback is the standard 5-minute cache-write rate and can be changed with `claudeDrainGuard.cost.fallbackCacheTtl`. Cloud-provider and fast-mode fallbacks are deliberately left unavailable unless Claude Code reports their cost, avoiding a misleading first-party estimate.

If `5h:—` remains visible, click **Connect live usage** in the dashboard. On setups where the official VS Code extension keeps its login isolated, this opens the bundled official Claude Code CLI for a one-time OAuth login; Claude Drain Guard never receives or stores the token itself.

## Performance

- Event-driven reads target only the JSONL file that changed
- Configurable 1–60 second checks touch only known active files
- Full session discovery is asynchronous and runs once per minute
- Appended data is streamed in 256 KB chunks; incomplete JSONL tails are preserved
- State writes are asynchronous, atomic, and coalesced only after new data

No prompts, source code, credentials, or telemetry are collected. Local anomaly monitoring remains independent of the network. Live 5h/7d usage is enabled by default: when a readable Claude OAuth token is available, the adapter makes a read-only `GET /api/oauth/usage` request at most once per five minutes. When Claude Code keeps its token private, the extension can passively observe the official VS Code extension's response for that exact Anthropic endpoint. No model prompt is sent, and the token is never logged or persisted. The feature can be disabled with `claudeDrainGuard.authoritativeQuota.enabled`.

## Development

Open this folder in VS Code and press `F5`. Run `node --test test/*.test.js` for the detector tests.

To create a Marketplace package, increment `version` in `package.json` for every release, then run `npx @vscode/vsce package --no-dependencies`. Never reuse a version that has already been uploaded.

## Commands

- `Claude Drain Guard: Open Dashboard`
- `Claude Drain Guard: Connect Live Usage`
- `Claude Drain Guard: Show Details`
- `Claude Drain Guard: Generate Incident Report`
- `Claude Drain Guard: Mute Alerts for 15 Minutes`
- `Claude Drain Guard: Reset Baseline`

## Privacy and security

See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md). This is a community project and is not affiliated with or endorsed by Anthropic.
