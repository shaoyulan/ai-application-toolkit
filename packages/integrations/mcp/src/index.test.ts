import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { defineTool } from '@ai-application-toolkit/tool'
import { defineGuardrail } from '@ai-application-toolkit/guardrail'
import { createMcpServer, toolToMcp, toMcpContent } from './index'

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

const stats = defineTool({
  id: 'stats',
  execute: () => ({ count: 2, ok: true })
})

async function connectClient(server: ReturnType<typeof createMcpServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

describe('toolToMcp', () => {
  it('maps id to name and forwards the input schema', () => {
    expect(toolToMcp(greet)).toEqual({
      name: 'greet',
      description: 'Greet someone by name',
      inputSchema: greet.input
    })
  })

  it('defaults to an empty object schema when no input is declared', () => {
    expect(toolToMcp(stats).inputSchema).toEqual({ type: 'object', properties: {} })
  })
})

describe('toMcpContent', () => {
  it('passes strings through', () => {
    expect(toMcpContent('hi')).toEqual({ content: [{ type: 'text', text: 'hi' }] })
  })

  it('JSON-encodes non-string output', () => {
    const result = toMcpContent({ a: 1 })
    expect(result.content[0]).toMatchObject({ type: 'text' })
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ a: 1 })
  })
})

describe('createMcpServer (round trip over in-memory transport)', () => {
  it('lists exposed tools with their schemas', async () => {
    const client = await connectClient(
      createMcpServer({ name: 'test', version: '1.0.0', tools: [greet, stats] })
    )
    const { tools } = await client.listTools()

    expect(tools.map((t) => t.name).sort()).toEqual(['greet', 'stats'])
    const greetTool = tools.find((t) => t.name === 'greet')
    expect(greetTool?.description).toBe('Greet someone by name')
    expect(greetTool?.inputSchema).toMatchObject({ required: ['name'] })
  })

  it('calls a tool and returns its output as text', async () => {
    const client = await connectClient(
      createMcpServer({ name: 'test', version: '1.0.0', tools: [greet] })
    )
    const result = await client.callTool({ name: 'greet', arguments: { name: 'Ada' } })
    expect(result.content).toEqual([{ type: 'text', text: 'Hello, Ada' }])
    expect(result.isError).toBeFalsy()
  })

  it('JSON-encodes object output', async () => {
    const client = await connectClient(
      createMcpServer({ name: 'test', version: '1.0.0', tools: [stats] })
    )
    const result = await client.callTool({ name: 'stats', arguments: {} })
    const content = result.content as Array<{ type: string; text: string }>
    expect(JSON.parse(content[0].text)).toEqual({ count: 2, ok: true })
  })

  it('returns isError for invalid input (schema validation)', async () => {
    const client = await connectClient(
      createMcpServer({ name: 'test', version: '1.0.0', tools: [greet] })
    )
    const result = await client.callTool({ name: 'greet', arguments: { name: 123 } })
    expect(result.isError).toBe(true)
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].text).toContain('TOOL_INPUT_INVALID')
  })

  it('returns isError for an unknown tool', async () => {
    const client = await connectClient(
      createMcpServer({ name: 'test', version: '1.0.0', tools: [greet] })
    )
    const result = await client.callTool({ name: 'nope', arguments: {} })
    expect(result.isError).toBe(true)
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].text).toContain('TOOL_NOT_FOUND')
  })

  it('applies runtime guardrails before execution', async () => {
    const block = defineGuardrail({
      id: 'block-all',
      check: () => ({ allowed: false, reason: 'denied' })
    })
    const client = await connectClient(
      createMcpServer({
        name: 'test',
        version: '1.0.0',
        tools: [greet],
        runtime: { guardrails: [block] }
      })
    )
    const result = await client.callTool({ name: 'greet', arguments: { name: 'Ada' } })
    expect(result.isError).toBe(true)
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].text).toContain('GUARDRAIL_BLOCKED')
  })
})
