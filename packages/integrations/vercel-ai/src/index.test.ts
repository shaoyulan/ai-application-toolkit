import { describe, expect, it } from 'vitest'
import { defineTool } from '@ai-application-toolkit/tool'
import { defineGuardrail } from '@ai-application-toolkit/guardrail'
import { toVercelTools } from './index'

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

// The AI SDK's tool union types `execute` loosely; cast to call it directly.
function exec(toolEntry: unknown, input: unknown) {
  const fn = (toolEntry as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute
  return fn(input, { toolCallId: 'test', messages: [] })
}

describe('toVercelTools', () => {
  it('produces one AI SDK tool per toolkit tool, keyed by id', () => {
    const set = toVercelTools([greet])
    expect(Object.keys(set)).toEqual(['greet'])
    expect(set.greet.description).toBe('Greet someone by name')
    expect(set.greet.inputSchema).toBeDefined()
  })

  it('routes execute through the runtime and returns the output', async () => {
    const set = toVercelTools([greet])
    expect(await exec(set.greet, { name: 'Ada' })).toBe('Hello, Ada')
  })

  it('enforces input validation from the tool schema', async () => {
    const set = toVercelTools([greet])
    await expect(exec(set.greet, { name: 123 })).rejects.toMatchObject({
      code: 'TOOL_INPUT_INVALID'
    })
  })

  it('applies runtime guardrails', async () => {
    const block = defineGuardrail({
      id: 'block-all',
      check: () => ({ allowed: false, reason: 'denied' })
    })
    const set = toVercelTools([greet], { runtime: { guardrails: [block] } })
    await expect(exec(set.greet, { name: 'Ada' })).rejects.toMatchObject({
      code: 'GUARDRAIL_BLOCKED'
    })
  })

  it('defaults to an empty object schema when a tool declares no input', () => {
    const noInput = defineTool({ id: 'ping', execute: () => 'pong' })
    const set = toVercelTools([noInput])
    expect(set.ping.inputSchema).toBeDefined()
  })
})
