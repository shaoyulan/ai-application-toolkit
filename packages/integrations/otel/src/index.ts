import {
  trace as otelTrace,
  SpanStatusCode,
  type Attributes,
  type Span,
  type Tracer
} from '@opentelemetry/api'
import type { TraceEvent, TraceSink } from '@ai-application-toolkit/trace'

/**
 * GenAI semantic-convention attribute keys, kept as inline string constants so
 * this package depends only on the stable `@opentelemetry/api` and not on the
 * still-incubating `@opentelemetry/semantic-conventions` GenAI module. These
 * mirror the OpenTelemetry GenAI conventions for tool-execution spans.
 */
const ATTR_OPERATION_NAME = 'gen_ai.operation.name'
const ATTR_TOOL_NAME = 'gen_ai.tool.name'
const ATTR_TOOL_TYPE = 'gen_ai.tool.type'
const ATTR_ERROR_TYPE = 'error.type'
/** Toolkit-specific attribute: correlates a span back to a runtime run. */
const ATTR_RUN_ID = 'ai_toolkit.run_id'

export interface OpenTelemetryTraceSinkOptions {
  /**
   * Tracer used to record spans. Defaults to a tracer named
   * `@ai-application-toolkit/otel` from the global OpenTelemetry API, so the
   * sink uses whatever SDK the application has configured.
   */
  tracer?: Tracer
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Adapts toolkit trace events into OpenTelemetry spans. One span is opened per
 * runtime run (keyed by `runId`) on `runtime:start` and closed on
 * `runtime:end` / `runtime:error`; tool and guardrail events are recorded as
 * span events on it. Wire it in like any other trace sink:
 *
 * @example
 * import { createRuntime } from '@ai-application-toolkit/runtime'
 * import { createOpenTelemetryTraceSink } from '@ai-application-toolkit/otel'
 *
 * const runtime = createRuntime({
 *   tools,
 *   trace: createOpenTelemetryTraceSink()
 * })
 */
export function createOpenTelemetryTraceSink(
  options: OpenTelemetryTraceSinkOptions = {}
): TraceSink {
  const tracer = options.tracer ?? otelTrace.getTracer('@ai-application-toolkit/otel')

  // Active span per run. A run with no matching start is ignored defensively.
  const spans = new Map<string, Span>()

  function finish(event: TraceEvent, span: Span): void {
    span.end(event.timestamp)
    spans.delete(event.runId)
  }

  return {
    emit(event: TraceEvent) {
      const span = spans.get(event.runId)

      switch (event.type) {
        case 'runtime:start': {
          const toolId = asString(event.data?.toolId)
          const attributes: Attributes = {
            [ATTR_OPERATION_NAME]: 'execute_tool',
            [ATTR_TOOL_TYPE]: 'function',
            [ATTR_RUN_ID]: event.runId
          }
          if (toolId) {
            attributes[ATTR_TOOL_NAME] = toolId
          }
          spans.set(
            event.runId,
            tracer.startSpan(toolId ? `execute_tool ${toolId}` : 'execute_tool', {
              startTime: event.timestamp,
              attributes
            })
          )
          break
        }

        case 'tool:start':
        case 'tool:end': {
          span?.addEvent(event.type, event.timestamp)
          break
        }

        case 'guardrail:blocked': {
          if (!span) break
          const attributes: Attributes = {}
          const guardrailId = asString(event.data?.guardrailId)
          const reason = asString(event.data?.reason)
          if (guardrailId) attributes['ai_toolkit.guardrail.id'] = guardrailId
          if (reason) attributes['ai_toolkit.guardrail.reason'] = reason
          span.addEvent('guardrail:blocked', attributes, event.timestamp)
          break
        }

        case 'tool:error': {
          if (span && event.data?.cause instanceof Error) {
            span.recordException(event.data.cause, event.timestamp)
          }
          break
        }

        case 'runtime:error': {
          if (!span) break
          const code = asString(event.data?.code)
          span.setStatus({ code: SpanStatusCode.ERROR, message: code })
          if (code) {
            span.setAttribute(ATTR_ERROR_TYPE, code)
          }
          finish(event, span)
          break
        }

        case 'runtime:end': {
          if (!span) break
          span.setStatus({ code: SpanStatusCode.OK })
          finish(event, span)
          break
        }
      }
    }
  }
}
