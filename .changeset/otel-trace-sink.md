---
"@ai-application-toolkit/otel": minor
---

New integration: `@ai-application-toolkit/otel`. `createOpenTelemetryTraceSink`
adapts toolkit trace events into OpenTelemetry spans following the GenAI
semantic conventions — one span per runtime run, with `gen_ai.*` attributes,
`tool:start`/`tool:end`/`guardrail:blocked` span events, and `ERROR` status
carrying the `ToolkitError` code on failure. Drop it into
`createRuntime({ trace })` to export execution to any OTLP/Jaeger backend.
