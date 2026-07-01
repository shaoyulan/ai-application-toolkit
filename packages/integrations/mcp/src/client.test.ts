import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server as HttpServer } from 'node:http'
import { execPath } from 'node:process'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@ai-application-toolkit/tool'
import { createRuntime } from '@ai-application-toolkit/runtime'
import { ToolkitError } from '@ai-application-toolkit/core'
import { startHttpMcpServer } from './http'
import { connectMcpClient, fromMcpContent, type McpClientHandle } from './client'

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

const stats = defineTool({ id: 'stats', execute: () => ({ count: 2, ok: true }) })

let server: HttpServer | undefined
let remote: McpClientHandle | undefined

afterEach(async () => {
  await remote?.close().catch(() => {})
  remote = undefined
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
  }
})

async function serve() {
  server = await startHttpMcpServer({
    name: 'upstream',
    version: '1.0.0',
    tools: [greet, stats],
    port: 0
  })
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}/mcp`
}

describe('fromMcpContent', () => {
  it('returns the text of a single text block', () => {
    expect(fromMcpContent({ content: [{ type: 'text', text: 'hi' }] })).toBe('hi')
  })

  it('prefers structuredContent when present', () => {
    expect(
      fromMcpContent({ content: [{ type: 'text', text: '{}' }], structuredContent: { a: 1 } })
    ).toEqual({ a: 1 })
  })

  it('returns the raw blocks when the result is not a single text block', () => {
    const blocks = [
      { type: 'text' as const, text: 'first' },
      { type: 'text' as const, text: 'second' }
    ]
    expect(fromMcpContent({ content: blocks })).toEqual(blocks)
    // No content at all also falls through to the (empty) block array.
    expect(fromMcpContent({ content: [] })).toEqual([])
  })

  it('throws a ToolkitError when the result is an error', () => {
    expect(() => fromMcpContent({ content: [{ type: 'text', text: 'boom' }], isError: true })).toThrow(
      ToolkitError
    )
  })

  it('falls back to a default message when an error result has no text', () => {
    expect(() => fromMcpContent({ content: [], isError: true })).toThrow(
      'Remote MCP tool reported an error'
    )
  })

  it('treats a result with no content array as empty blocks', () => {
    expect(fromMcpContent({} as never)).toEqual([])
  })
})

describe('connectMcpClient (wraps a remote server over Streamable HTTP)', () => {
  it('exposes remote tools as toolkit tools with an optional id prefix', async () => {
    const url = await serve()
    remote = await connectMcpClient({ transport: { kind: 'http', url }, toolIdPrefix: 'remote.' })

    expect(remote.tools.map((t) => t.id).sort()).toEqual(['remote.greet', 'remote.stats'])
    const greetTool = remote.tools.find((t) => t.id === 'remote.greet')
    expect(greetTool?.description).toBe('Greet someone by name')
    expect(greetTool?.input).toMatchObject({ required: ['name'] })
  })

  it('passes custom headers on the HTTP transport', async () => {
    const url = await serve()
    remote = await connectMcpClient({
      transport: { kind: 'http', url, headers: { 'x-api-key': 'secret' } }
    })
    expect(remote.tools.map((t) => t.id).sort()).toEqual(['greet', 'stats'])
  })

  it('executes a wrapped tool through the runtime end-to-end', async () => {
    const url = await serve()
    remote = await connectMcpClient({ transport: { kind: 'http', url } })

    const runtime = createRuntime({ tools: remote.tools })
    expect(await runtime.executeTool({ toolId: 'greet', input: { name: 'Ada' } })).toBe('Hello, Ada')

    const out = await runtime.executeTool({ toolId: 'stats', input: {} })
    expect(JSON.parse(out as string)).toEqual({ count: 2, ok: true })
  })

  it('surfaces an upstream tool error as a ToolkitError', async () => {
    const url = await serve()
    remote = await connectMcpClient({ transport: { kind: 'http', url } })
    const greetTool = remote.tools.find((t) => t.id === 'greet')!

    // Call execute directly to bypass local validation and let the upstream
    // server reject the input — the MCP tool error must become a ToolkitError.
    await expect(greetTool.execute({ name: 123 })).rejects.toMatchObject({
      code: 'MCP_TOOL_ERROR'
    })
  })
})

describe('connectMcpClient (stdio transport)', () => {
  const serverPath = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url))

  it('spawns a stdio server and wraps its tools, carrying optional fields', async () => {
    remote = await connectMcpClient({
      transport: { kind: 'stdio', command: execPath, args: [serverPath] }
    })

    expect(remote.tools.map((t) => t.id).sort()).toEqual(['bare', 'echo'])

    // `echo` carries description + inputSchema; `bare` has neither, so the
    // conditional-spread branches in loadTools are both exercised.
    const echo = remote.tools.find((t) => t.id === 'echo')!
    expect(echo.description).toBe('Echoes its message back')
    expect(echo.input).toMatchObject({ required: ['message'] })

    const bare = remote.tools.find((t) => t.id === 'bare')!
    expect(bare.description).toBeUndefined()

    const runtime = createRuntime({ tools: remote.tools })
    expect(await runtime.executeTool({ toolId: 'echo', input: { message: 'ping' } })).toBe('ping')

    // `bare` returns two text blocks -> the multi-block path returns the array.
    const blocks = (await bare.execute({})) as { type: string; text: string }[]
    expect(blocks.map((b) => b.text)).toEqual(['first', 'second'])
  })

  it('re-fetches tools via listTools()', async () => {
    remote = await connectMcpClient({
      transport: { kind: 'stdio', command: execPath, args: [serverPath] }
    })
    const refetched = await remote.listTools()
    expect(refetched.map((t) => t.id).sort()).toEqual(['bare', 'echo'])
  })
})
