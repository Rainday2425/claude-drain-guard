# Privacy

Claude Drain Guard is local-first and has no telemetry.

By default it reads usage metadata from Claude Code JSONL transcripts under the configured Claude directory. It does not collect or persist prompt text, responses, source code, credentials, or tool arguments. Aggregated detector state and generated incident reports remain in VS Code extension storage on the local machine.

The authoritative quota feature is enabled by default and can be disabled in settings for local-only monitoring. It reads the existing Claude OAuth access token into memory, sends at most one minimal one-token Haiku request per five minutes, and reads rate-limit response headers. The access token is never logged, copied into reports, or persisted by this extension. This request consumes a small amount of Claude allowance.

No analytics or advertising services are used.
