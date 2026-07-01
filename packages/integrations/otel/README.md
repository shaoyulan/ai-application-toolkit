# @ai-application-toolkit/otel

Export AI Application Toolkit runtime execution as [OpenTelemetry](https://opentelemetry.io)
spans. `createOpenTelemetryTraceSink` is a drop-in [trace sink](https://github.com/shaoyulan/ai-application-toolkit/tree/main/packages/trace#readme):
hand it to `createRuntime({ trace })` and every tool execution becomes a span
following the OpenTelemetry GenAI semantic conventions.

Part of the [AI Application Toolkit](https://github.com/shaoyulan/ai-application-toolkit#readme).

## Install

```bash
pnpm add @ai-application-toolkit/otel @opentelemetry/api
```

## Usage

The sink uses whatever tracer your application's OpenTelemetry SDK has
configured — point your exporter (OTLP, Jaeger, etc.) at it as usual.

```ts
import { createRuntime } from '@ai-application-toolkit/runtime'
import { createOpenTelemetryTraceSink } from '@ai-application-toolkit/otel'

const runtime = createRuntime({
  tools,
  trace: createOpenTelemetryTraceSink()
})

// Every executeTool call now emits a span.
await runtime.executeTool({ toolId: 'search', input: { query: 'otel' } })
```

Pass an explicit `tracer` to scope spans to a named instrumentation:

```ts
import { trace } from '@opentelemetry/api'

createOpenTelemetryTraceSink({ tracer: trace.getTracer('my-app') })
```

## What it emits

One span per runtime run (correlated by `runId`):

- **Name** — `execute_tool <toolId>`
- **Attributes** — `gen_ai.operation.name = "execute_tool"`,
  `gen_ai.tool.name`, `gen_ai.tool.type = "function"`, and `ai_toolkit.run_id`
- **Span events** — `tool:start`, `tool:end`, and `guardrail:blocked`
  (with the guardrail id and reason)
- **Status** — `OK` on success; `ERROR` with `error.type` set to the
  `ToolkitError` code (`TOOL_TIMEOUT`, `GUARDRAIL_BLOCKED`,
  `TOOL_EXECUTION_FAILED`, …) on failure, with the thrown error recorded as a
  span exception

## License

MIT © Danny LAN
