# Security policy

## Reporting a vulnerability

Please open a GitHub security advisory in this repository rather than posting credential-related details in a public issue.

Never include Claude OAuth tokens, `.credentials.json`, session transcripts, prompts, source code, or private repository paths in a report.

## Data handling

- Local monitoring is read-only with respect to Claude Code transcripts.
- OAuth quota sampling is opt-in and tokens remain in process memory only.
- Network failure never disables the local detector.
- Incident reports contain numeric usage metadata, detector evidence, timestamps, model labels, and sanitized project grouping only.
