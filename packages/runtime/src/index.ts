import { ToolkitError } from '@ai-application-toolkit/core'
import type { ToolkitContextData, ToolkitExecutionContext } from '@ai-application-toolkit/core'
import { validateInput, type AnyToolDefinition } from '@ai-application-toolkit/tool'
import type { Guardrail } from '@ai-application-toolkit/guardrail'
import { createContext, type ToolkitContext } from '@ai-application-toolkit/context'
import type { TraceSink } from '@ai-application-toolkit/trace'

export interface RuntimeOptions {
  tools?: AnyToolDefinition[]
  /** Guardrails run as middleware before every tool execution. */
  guardrails?: Guardrail[]
  /** Base context shared across runs. Per-call context is merged on top. */
  context?: ToolkitContext | ToolkitContextData
  trace?: TraceSink
  /** Default timeout (ms) applied to every tool execution. */
  timeoutMs?: number
}

export interface ExecuteToolInput {
  toolId: string
  input: unknown
  runId?: string
  /** Per-run context, merged onto the runtime's base context. */
  context?: ToolkitContextData
  /** Caller-supplied cancellation signal. */
  signal?: AbortSignal
  /** Per-run timeout (ms). Overrides the runtime default. */
  timeoutMs?: number
}

function toContext(value?: ToolkitContext | ToolkitContextData): ToolkitContext {
  if (!value) {
    return createContext()
  }
  // A ToolkitContext exposes merge(); raw context data does not.
  if (typeof (value as ToolkitContext).merge === 'function') {
    return value as ToolkitContext
  }
  return createContext(value as ToolkitContextData)
}

export function createRuntime(options: RuntimeOptions = {}) {
  const tools = new Map((options.tools ?? []).map((tool) => [tool.id, tool]))
  const guardrails = options.guardrails ?? []
  const baseContext = toContext(options.context)

  async function executeTool({
    toolId,
    input,
    runId = crypto.randomUUID(),
    context,
    signal: callerSignal,
    timeoutMs
  }: ExecuteToolInput) {
    // Context is frozen for the duration of the run (AGENTS.md rule 5).
    const runContext = context ? baseContext.merge(context) : baseContext
    const effectiveTimeout = timeoutMs ?? options.timeoutMs

    options.trace?.emit({
      type: 'runtime:start',
      timestamp: Date.now(),
      runId,
      data: { toolId }
    })

    const tool = tools.get(toolId)

    if (!tool) {
      options.trace?.emit({
        type: 'runtime:error',
        timestamp: Date.now(),
        runId,
        data: { toolId, code: 'TOOL_NOT_FOUND' }
      })

      throw new ToolkitError({
        code: 'TOOL_NOT_FOUND',
        message: `Tool not found: ${toolId}`
      })
    }

    // Validate the input against the tool's declared JSON Schema, if any.
    if (tool.input) {
      const result = validateInput(tool.input, input)
      if (!result.valid) {
        options.trace?.emit({
          type: 'runtime:error',
          timestamp: Date.now(),
          runId,
          data: { toolId, code: 'TOOL_INPUT_INVALID', errors: result.errors }
        })

        const detail = result.errors
          .map((e) => `${e.path || '(root)'}: ${e.message}`)
          .join('; ')

        throw new ToolkitError({
          code: 'TOOL_INPUT_INVALID',
          message: `Invalid input for tool ${toolId}: ${detail}`
        })
      }
    }

    // Guardrails as middleware (AGENTS.md rule 7): all must allow the input.
    // The run context (including caller identity in metadata.auth) is passed so
    // guardrails can authorize per tool, not just inspect the raw input.
    for (const guardrail of guardrails) {
      const result = await guardrail.check(input, {
        toolId,
        data: runContext.data
      })

      if (!result.allowed) {
        options.trace?.emit({
          type: 'guardrail:blocked',
          timestamp: Date.now(),
          runId,
          data: { toolId, guardrailId: guardrail.id, reason: result.reason }
        })

        options.trace?.emit({
          type: 'runtime:error',
          timestamp: Date.now(),
          runId,
          data: { toolId, code: 'GUARDRAIL_BLOCKED' }
        })

        throw new ToolkitError({
          code: 'GUARDRAIL_BLOCKED',
          message: `Guardrail blocked execution: ${guardrail.id}${
            result.reason ? ` (${result.reason})` : ''
          }`
        })
      }
    }

    options.trace?.emit({
      type: 'tool:start',
      timestamp: Date.now(),
      runId,
      data: { toolId }
    })

    // Combine the caller's signal and the timeout into one controller, which is
    // also handed to the tool so cooperative tools can stop early.
    const controller = new AbortController()
    const onCallerAbort = () =>
      controller.abort(
        callerSignal?.reason instanceof ToolkitError
          ? callerSignal.reason
          : new ToolkitError({
              code: 'TOOL_ABORTED',
              message: `Tool execution aborted: ${toolId}`,
              cause: callerSignal?.reason
            })
      )

    if (callerSignal) {
      if (callerSignal.aborted) {
        onCallerAbort()
      } else {
        callerSignal.addEventListener('abort', onCallerAbort, { once: true })
      }
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    if (effectiveTimeout !== undefined && !controller.signal.aborted) {
      timer = setTimeout(
        () =>
          controller.abort(
            new ToolkitError({
              code: 'TOOL_TIMEOUT',
              message: `Tool timed out after ${effectiveTimeout}ms: ${toolId}`
            })
          ),
        effectiveTimeout
      )
    }

    const execContext: ToolkitExecutionContext = {
      data: runContext.data,
      signal: controller.signal
    }

    try {
      if (controller.signal.aborted) {
        throw controller.signal.reason
      }

      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(controller.signal.reason),
          { once: true }
        )
      })

      const output = await Promise.race([
        Promise.resolve(tool.execute(input, execContext)),
        aborted
      ])

      options.trace?.emit({
        type: 'tool:end',
        timestamp: Date.now(),
        runId,
        data: { toolId }
      })

      options.trace?.emit({
        type: 'runtime:end',
        timestamp: Date.now(),
        runId,
        data: { toolId }
      })

      return output
    } catch (cause) {
      const isControlError =
        cause instanceof ToolkitError &&
        (cause.code === 'TOOL_TIMEOUT' || cause.code === 'TOOL_ABORTED')

      options.trace?.emit({
        type: 'tool:error',
        timestamp: Date.now(),
        runId,
        data: { toolId, cause }
      })

      options.trace?.emit({
        type: 'runtime:error',
        timestamp: Date.now(),
        runId,
        data: { toolId, code: isControlError ? cause.code : 'TOOL_EXECUTION_FAILED' }
      })

      if (isControlError) {
        throw cause
      }

      throw new ToolkitError({
        code: 'TOOL_EXECUTION_FAILED',
        message: `Tool execution failed: ${toolId}`,
        cause
      })
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
      if (callerSignal) {
        callerSignal.removeEventListener('abort', onCallerAbort)
      }
    }
  }

  return {
    executeTool
  }
}
