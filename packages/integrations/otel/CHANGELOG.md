# @ai-application-toolkit/otel

## 0.1.0

### Minor Changes

- ef4faa4: New integration: `@ai-application-toolkit/otel`. `createOpenTelemetryTraceSink`
  adapts toolkit trace events into OpenTelemetry spans following the GenAI
  semantic conventions — one span per runtime run, with `gen_ai.*` attributes,
  `tool:start`/`tool:end`/`guardrail:blocked` span events, and `ERROR` status
  carrying the `ToolkitError` code on failure. Drop it into
  `createRuntime({ trace })` to export execution to any OTLP/Jaeger backend.

### Patch Changes

- Updated dependencies [b556a67]
  - @ai-application-toolkit/trace@0.1.0
