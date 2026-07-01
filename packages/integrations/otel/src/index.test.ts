import { describe, expect, it } from 'vitest'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan
} from '@opentelemetry/sdk-trace-base'
import { SpanStatusCode, trace } from '@opentelemetry/api'
import { defineTool } from '@ai-application-toolkit/tool'
import { defineGuardrail } from '@ai-application-toolkit/guardrail'
import { createRuntime } from '@ai-application-toolkit/runtime'
import { createOpenTelemetryTraceSink } from './index'

function setup() {
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)]
  })
  const tracer = provider.getTracer('test')
  return { exporter, trace: createOpenTelemetryTraceSink({ tracer }) }
}

const greet = defineTool({
  id: 'greet',
  input: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false
  },
  execute: (input: { name: string }) => `Hello, ${input.name}`
})

const boom = defineTool({
  id: 'boom',
  execute: () => {
    throw new Error('kaboom')
  }
})

function only(exporter: InMemorySpanExporter): ReadableSpan {
  const spans = exporter.getFinishedSpans()
  expect(spans).toHaveLength(1)
  return spans[0]
}

describe('createOpenTelemetryTraceSink', () => {
  it('records a successful run as one OK span with GenAI attributes', async () => {
    const { exporter, trace } = setup()
    const runtime = createRuntime({ tools: [greet], trace })

    await runtime.executeTool({ toolId: 'greet', input: { name: 'Ada' } })

    const span = only(exporter)
    expect(span.name).toBe('execute_tool greet')
    expect(span.status.code).toBe(SpanStatusCode.OK)
    expect(span.attributes['gen_ai.operation.name']).toBe('execute_tool')
    expect(span.attributes['gen_ai.tool.name']).toBe('greet')
    expect(span.events.map((e) => e.name)).toEqual(['tool:start', 'tool:end'])
  })

  it('marks a failed tool run as an ERROR span with the error code and exception', async () => {
    const { exporter, trace } = setup()
    const runtime = createRuntime({ tools: [boom], trace })

    await expect(
      runtime.executeTool({ toolId: 'boom', input: {} })
    ).rejects.toMatchObject({ code: 'TOOL_EXECUTION_FAILED' })

    const span = only(exporter)
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(span.attributes['error.type']).toBe('TOOL_EXECUTION_FAILED')
    expect(span.events.some((e) => e.name === 'exception')).toBe(true)
  })

  it('records a guardrail denial as a span event and ERROR status', async () => {
    const { exporter, trace } = setup()
    const block = defineGuardrail({
      id: 'block-all',
      check: () => ({ allowed: false, reason: 'denied' })
    })
    const runtime = createRuntime({ tools: [greet], guardrails: [block], trace })

    await expect(
      runtime.executeTool({ toolId: 'greet', input: { name: 'Ada' } })
    ).rejects.toMatchObject({ code: 'GUARDRAIL_BLOCKED' })

    const span = only(exporter)
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(span.attributes['error.type']).toBe('GUARDRAIL_BLOCKED')
    const blocked = span.events.find((e) => e.name === 'guardrail:blocked')
    expect(blocked?.attributes).toMatchObject({
      'ai_toolkit.guardrail.id': 'block-all',
      'ai_toolkit.guardrail.reason': 'denied'
    })
  })

  it('ignores events for a run that never started', () => {
    const { exporter, trace } = setup()
    trace.emit({ type: 'runtime:end', timestamp: 1, runId: 'never' })
    expect(exporter.getFinishedSpans()).toHaveLength(0)
  })

  it('falls back to a plain execute_tool span when toolId is absent or non-string', () => {
    const { exporter, trace } = setup()
    // toolId omitted entirely
    trace.emit({ type: 'runtime:start', timestamp: 1, runId: 'a' })
    trace.emit({ type: 'runtime:end', timestamp: 2, runId: 'a' })
    // toolId present but not a string -> asString returns undefined
    trace.emit({
      type: 'runtime:start',
      timestamp: 3,
      runId: 'b',
      data: { toolId: 42 }
    })
    trace.emit({ type: 'runtime:end', timestamp: 4, runId: 'b' })

    const spans = exporter.getFinishedSpans()
    expect(spans).toHaveLength(2)
    for (const span of spans) {
      expect(span.name).toBe('execute_tool')
      expect(span.attributes['gen_ai.tool.name']).toBeUndefined()
      expect(span.attributes['gen_ai.operation.name']).toBe('execute_tool')
    }
  })

  it('records tool:start/tool:end and tool:error as events and an exception', () => {
    const { exporter, trace } = setup()
    const cause = new Error('boom')
    trace.emit({ type: 'runtime:start', timestamp: 1, runId: 'r', data: { toolId: 't' } })
    trace.emit({ type: 'tool:start', timestamp: 2, runId: 'r' })
    trace.emit({ type: 'tool:error', timestamp: 3, runId: 'r', data: { cause } })
    trace.emit({ type: 'tool:end', timestamp: 4, runId: 'r' })
    trace.emit({ type: 'runtime:end', timestamp: 5, runId: 'r' })

    const span = only(exporter)
    expect(span.events.map((e) => e.name)).toEqual([
      'tool:start',
      'exception',
      'tool:end'
    ])
  })

  it('ignores a tool:error whose cause is not an Error instance', () => {
    const { exporter, trace } = setup()
    trace.emit({ type: 'runtime:start', timestamp: 1, runId: 'r', data: { toolId: 't' } })
    trace.emit({ type: 'tool:error', timestamp: 2, runId: 'r', data: { cause: 'nope' } })
    trace.emit({ type: 'runtime:end', timestamp: 3, runId: 'r' })

    const span = only(exporter)
    expect(span.events.some((e) => e.name === 'exception')).toBe(false)
  })

  it('marks a runtime:error with no code as ERROR without an error.type attribute', () => {
    const { exporter, trace } = setup()
    trace.emit({ type: 'runtime:start', timestamp: 1, runId: 'r', data: { toolId: 't' } })
    trace.emit({ type: 'runtime:error', timestamp: 2, runId: 'r' })

    const span = only(exporter)
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(span.attributes['error.type']).toBeUndefined()
  })

  it('omits guardrail attributes that are missing or non-string', () => {
    const { exporter, trace } = setup()
    trace.emit({ type: 'runtime:start', timestamp: 1, runId: 'r', data: { toolId: 't' } })
    trace.emit({
      type: 'guardrail:blocked',
      timestamp: 2,
      runId: 'r',
      data: { guardrailId: 123, reason: null }
    })
    trace.emit({ type: 'runtime:end', timestamp: 3, runId: 'r' })

    const span = only(exporter)
    const blocked = span.events.find((e) => e.name === 'guardrail:blocked')
    expect(blocked).toBeDefined()
    expect(blocked?.attributes).toEqual({})
  })

  it('ignores guardrail:blocked, tool:error and runtime:error for a run that never started', () => {
    const { exporter, trace } = setup()
    trace.emit({ type: 'guardrail:blocked', timestamp: 1, runId: 'x', data: {} })
    trace.emit({ type: 'tool:error', timestamp: 2, runId: 'x', data: { cause: new Error('e') } })
    trace.emit({ type: 'runtime:error', timestamp: 3, runId: 'x', data: { code: 'X' } })
    expect(exporter.getFinishedSpans()).toHaveLength(0)
  })

  it('uses the global tracer when no tracer option is provided', () => {
    const exporter = new InMemorySpanExporter()
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)]
    })
    const previous = trace.getTracerProvider()
    trace.setGlobalTracerProvider(provider)
    try {
      const sink = createOpenTelemetryTraceSink()
      sink.emit({ type: 'runtime:start', timestamp: 1, runId: 'g', data: { toolId: 't' } })
      sink.emit({ type: 'runtime:end', timestamp: 2, runId: 'g' })

      const span = only(exporter)
      expect(span.name).toBe('execute_tool t')
      expect(span.status.code).toBe(SpanStatusCode.OK)
    } finally {
      trace.disable()
      trace.setGlobalTracerProvider(previous)
    }
  })
})
