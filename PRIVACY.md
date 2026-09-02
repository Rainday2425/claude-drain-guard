# Privacy

Claude Drain Guard is local-first and has no telemetry.

By default it reads usage metadata from Claude Code JSONL transcripts under the configured Claude directory. It does not collect or persist prompt text, responses, source code, credentials, or tool arguments. Aggregated detector state and generated incident reports remain in VS Code extension storage on the local machine.

The authoritative quota feature is enabled by default and can be disabled in settings for local-only monitoring. If a readable Claude OAuth access token is available, it is used in memory for a read-only `GET https://api.anthropic.com/api/oauth/usage` request at most once per five minutes. If the official Claude Code VS Code extension owns the login, Claude Drain Guard can instead passively observe only that extension's successful response for the same exact Anthropic host and path. No prompt or model request is sent. The access token and raw response are never logged, copied into reports, or persisted by this extension.

No analytics or advertising services are used.
