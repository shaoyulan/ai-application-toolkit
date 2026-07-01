---
"@ai-application-toolkit/codegraph": minor
"@ai-application-toolkit/mcp": patch
---

codegraph `serve` now auto-selects a free port. Omitting `--port` picks the first free port from 3000, and an explicitly requested but busy port warns and falls back to the next free one. Port conflicts are detected via a connect-probe on both loopback stacks (127.0.0.1 and ::1), which catches the case where a wildcard bind silently coexists with an existing listener on a specific loopback address. `startHttpMcpServer` now rejects on listen errors instead of hanging.
