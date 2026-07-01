import { describe, expect, it } from 'vitest'
import { defineTool } from '@ai-application-toolkit/tool'
import { defineGuardrail } from '@ai-application-toolkit/guardrail'
import { createContext } from '@ai-application-toolkit/context'
import { createMemoryTraceSink } from '@ai-application-toolkit/trace'
import { ToolkitError } from '@ai-application-toolkit/core'
import { createRuntime } from './index'

const hello = defineTool({
  id: 'hello',
  execute: (input: { name: string }) => ({ message: `Hello, ${input.name}` })
})

describe('createRuntime.executeTool', () => {
  it('executes a registered tool and returns its output', async () => {
    const runtime = createRuntime({ tools: [hello] })
    const result = await runtime.executeTool({ toolId: 'hello', input: { name: 'AI' } })
    expect(result).toEqual({ message: 'Hello, AI' })
  })

  it('throws TOOL_NOT_FOUND for an unknown tool', async () => {
    const runtime = createRuntime({ tools: [hello] })
    await expect(
      runtime.executeTool({ toolId: 'nope', input: {} })
    ).rejects.toMatchObject({ code: 'TOOL_NOT_FOUND' })
  })

  it('wraps a throwing tool in TOOL_EXECUTION_FAILED and preserves the cause', async () => {
    const boom = defineTool({
      id: 'boom',
      execute: () => {
        throw new Error('kaboom')
      }
    })
    const runtime = createRuntime({ tools: [boom] })

    await expect(runtime.executeTool({ toolId: 'boom', input: {} })).rejects.toMatchObject({
      code: 'TOOL_EXECUTION_FAILED'
    })
    try {
      await runtime.executeTool({ toolId: 'boom', input: {} })
    } catch (error) {
      expect((error as ToolkitError).cause).toBeInstanceOf(Error)
    }
  })

  it('emits the full trace lifecycle on success', async () => {
    const trace = createMemoryTraceSink()
    const runtime = createRuntime({ tools: [hello], trace })
    await runtime.executeTool({ toolId: 'hello', input: { name: 'AI' }, runId: 'r1' })

    expect(trace.events.map((e) => e.type)).toEqual([
      'runtime:start',
      'tool:start',
      'tool:end',
      'runtime:end'
    ])
    expect(trace.events.every((e) => e.runId === 'r1')).toBe(true)
  })

  describe('guardrails (middleware)', () => {
    it('blocks execution when a guardrail disallows the input', async () => {
      const trace = createMemoryTraceSink()
      let executed = false
      const tool = defineTool({
        id: 'guarded',
        execute: () => {
          executed = true
          return 'ran'
        }
      })
      const block = defineGuardrail({
        id: 'always-block',
        check: () => ({ allowed: false, reason: 'nope' })
      })
      const runtime = createRuntime({ tools: [tool], guardrails: [block], trace })

      await expect(
        runtime.executeTool({ toolId: 'guarded', input: {} })
      ).rejects.toMatchObject({ code: 'GUARDRAIL_BLOCKED' })

      expect(executed).toBe(false)
      const types = trace.events.map((e) => e.type)
      expect(types).toContain('guardrail:blocked')
      expect(types).not.toContain('tool:start')
    })

    it('allows execution when all guardrails pass', async () => {
      const allow = defineGuardrail({ id: 'allow', check: () => ({ allowed: true }) })
      const runtime = createRuntime({ tools: [hello], guardrails: [allow] })
      const result = await runtime.executeTool({ toolId: 'hello', input: { name: 'AI' } })
      expect(result).toEqual({ message: 'Hello, AI' })
    })
  })

  describe('context', () => {
    it('passes the base context to the tool', async () => {
      let seen: unknown
      const tool = defineTool({
        id: 'ctx',
        execute: (_input, context) => {
          seen = context?.data.variables
          return 'ok'
        }
      })
      const runtime = createRuntime({ tools: [tool], context: { variables: { tenant: 'acme' } } })
      await runtime.executeTool({ toolId: 'ctx', input: {} })
      expect(seen).toEqual({ tenant: 'acme' })
    })

    it('merges per-call context onto the base context', async () => {
      let seen: Record<string, unknown> | undefined
      const tool = defineTool({
        id: 'ctx',
        execute: (_input, context) => {
          seen = context?.data.variables
          return 'ok'
        }
      })
      const runtime = createRuntime({
        tools: [tool],
        context: createContext({ variables: { tenant: 'acme' } })
      })
      await runtime.executeTool({ toolId: 'ctx', input: {}, context: { variables: { user: 'bob' } } })
      expect(seen).toEqual({ tenant: 'acme', user: 'bob' })
    })

    it('hands the tool an immutable (frozen) context', async () => {
      let frozen = false
      const tool = defineTool({
        id: 'ctx',
        execute: (_input, context) => {
          frozen = Object.isFrozen(context?.data)
          return 'ok'
        }
      })
      const runtime = createRuntime({ tools: [tool], context: { variables: { a: 1 } } })
      await runtime.executeTool({ toolId: 'ctx', input: {} })
      expect(frozen).toBe(true)
    })
  })

  describe('input validation', () => {
    const typed = defineTool({
      id: 'typed',
      input: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false
      },
      execute: (input: { name: string }) => `hi ${input.name}`
    })

    it('executes when input matches the schema', async () => {
      const runtime = createRuntime({ tools: [typed] })
      expect(await runtime.executeTool({ toolId: 'typed', input: { name: 'Ada' } })).toBe('hi Ada')
    })

    it('throws TOOL_INPUT_INVALID when input violates the schema', async () => {
      const runtime = createRuntime({ tools: [typed] })
      await expect(
        runtime.executeTool({ toolId: 'typed', input: { age: 1 } })
      ).rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' })
    })

    it('does not run the tool or guardrails on invalid input', async () => {
      let executed = false
      const tool = defineTool({
        id: 'typed2',
        input: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
        execute: () => {
          executed = true
          return 'ok'
        }
      })
      const trace = createMemoryTraceSink()
      const runtime = createRuntime({ tools: [tool], trace })

      await expect(
        runtime.executeTool({ toolId: 'typed2', input: { n: 'not-a-number' } })
      ).rejects.toMatchObject({ code: 'TOOL_INPUT_INVALID' })

      expect(executed).toBe(false)
      expect(trace.events.map((e) => e.type)).not.toContain('tool:start')
    })

    it('skips validation when the tool declares no input schema', async () => {
      const runtime = createRuntime({ tools: [hello] })
      expect(await runtime.executeTool({ toolId: 'hello', input: { name: 'Ada' } })).toEqual({
        message: 'Hello, Ada'
      })
    })
  })

  describe('timeout and cancellation', () => {
    const slow = defineTool({
      id: 'slow',
      execute: (_input, context) =>
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve('done'), 10_000)
          context?.signal?.addEventListener('abort', () => clearTimeout(timer), {
            once: true
          })
        })
    })

    it('throws TOOL_TIMEOUT when a tool exceeds the timeout', async () => {
      const runtime = createRuntime({ tools: [slow] })
      await expect(
        runtime.executeTool({ toolId: 'slow', input: {}, timeoutMs: 20 })
      ).rejects.toMatchObject({ code: 'TOOL_TIMEOUT' })
    })

    it('applies the runtime-level default timeout', async () => {
      const runtime = createRuntime({ tools: [slow], timeoutMs: 20 })
      await expect(
        runtime.executeTool({ toolId: 'slow', input: {} })
      ).rejects.toMatchObject({ code: 'TOOL_TIMEOUT' })
    })

    it('throws TOOL_ABORTED when the caller signal aborts', async () => {
      const runtime = createRuntime({ tools: [slow] })
      const controller = new AbortController()
      const promise = runtime.executeTool({
        toolId: 'slow',
        input: {},
        signal: controller.signal
      })
      controller.abort()
      await expect(promise).rejects.toMatchObject({ code: 'TOOL_ABORTED' })
    })

    it('rejects immediately when the caller signal is already aborted', async () => {
      const runtime = createRuntime({ tools: [hello] })
      await expect(
        runtime.executeTool({
          toolId: 'hello',
          input: { name: 'AI' },
          signal: AbortSignal.abort()
        })
      ).rejects.toMatchObject({ code: 'TOOL_ABORTED' })
    })

    it('passes the abort signal to the tool for cooperative cancellation', async () => {
      let sawAbort = false
      const tool = defineTool({
        id: 'observes',
        execute: (_input, context) =>
          new Promise((resolve) => {
            context?.signal?.addEventListener('abort', () => {
              sawAbort = true
              resolve('stopped')
            })
          })
      })
      const runtime = createRuntime({ tools: [tool] })
      await expect(
        runtime.executeTool({ toolId: 'observes', input: {}, timeoutMs: 20 })
      ).rejects.toMatchObject({ code: 'TOOL_TIMEOUT' })
      expect(sawAbort).toBe(true)
    })

    it('does not time out a fast tool', async () => {
      const runtime = createRuntime({ tools: [hello], timeoutMs: 1000 })
      const result = await runtime.executeTool({ toolId: 'hello', input: { name: 'AI' } })
      expect(result).toEqual({ message: 'Hello, AI' })
    })
  })
})
