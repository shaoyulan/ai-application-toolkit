import {
  BasicTracerProvider,
  ConsoleSpanExporter,
  SimpleSpanProcessor
} from '@opentelemetry/sdk-trace-base'
import { defineTool } from '@ai-application-toolkit/tool'
import { defineGuardrail } from '@ai-application-toolkit/guardrail'
import { createRuntime } from '@ai-application-toolkit/runtime'
import { createOpenTelemetryTraceSink } from '@ai-application-toolkit/otel'

// Configure an OpenTelemetry tracer. In production you'd swap ConsoleSpanExporter
// for an OTLP exporter pointing at your collector; here we just print spans.
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())]
})
const tracer = provider.getTracer('otel-example')

const greet = defineTool({
  id: 'greet',
  description: 'Greet someone by name',
  input: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false
  },
  execute: (input: { name: string }) => `Hello, ${input.name}`
})

// A guardrail so we can see a blocked run become an ERROR span too.
const noBob = defineGuardrail<{ name: string }>({
  id: 'no-bob',
  check: (input) =>
    input.name === 'Bob'
      ? { allowed: false, reason: 'Bob is not allowed' }
      : { allowed: true }
})

const runtime = createRuntime({
  tools: [greet],
  guardrails: [noBob],
  trace: createOpenTelemetryTraceSink({ tracer })
})

// Successful run -> one OK span with tool:start/tool:end events.
console.log(await runtime.executeTool({ toolId: 'greet', input: { name: 'Ada' } }))

// Blocked run -> one ERROR span with a guardrail:blocked event.
try {
  await runtime.executeTool({ toolId: 'greet', input: { name: 'Bob' } })
} catch (error) {
  console.log('blocked as expected:', (error as Error).message)
}

await provider.forceFlush()
await provider.shutdown()
