import { afterEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { defineTool } from '@ai-application-toolkit/tool'
import { defineScopeGuardrail } from '@ai-application-toolkit/guardrail'
import type { ToolkitAuthInfo } from '@ai-application-toolkit/core'
import { startHttpMcpServer } from './http'

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

let server: HttpServer | undefined
const clients: Client[] = []

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})))
  clients.length = 0
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
  }
})

async function connect(httpServer: HttpServer, headers?: Record<string, string>) {
  const { port } = httpServer.address() as AddressInfo
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  clients.push(client)
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: headers ? { headers } : undefined
    })
  )
  return client
}

describe('startHttpMcpServer (stateless round trip over real HTTP)', () => {
  it('lists and calls tools over Streamable HTTP', async () => {
    server = await startHttpMcpServer({ name: 'test', version: '1.0.0', tools: [greet], port: 0 })
    const client = await connect(server)

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['greet'])

    const result = await client.callTool({ name: 'greet', arguments: { name: 'Ada' } })
    expect(result.content).toEqual([{ type: 'text', text: 'Hello, Ada' }])
  })

  it('returns 404 for paths other than the MCP endpoint', async () => {
    server = await startHttpMcpServer({ name: 'test', version: '1.0.0', tools: [greet], port: 0 })
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/nope`)
    expect(res.status).toBe(404)
  })

  it('rejects unauthenticated requests with 401 when authenticate is set', async () => {
    server = await startHttpMcpServer({
      name: 'test',
      version: '1.0.0',
      tools: [greet],
      port: 0,
      authenticate: () => null
    })
    const { port } = server.address() as AddressInfo
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Bearer')
  })

  it('injects the authenticated caller into context for scope authorization', async () => {
    const authenticate = (req: IncomingMessage): ToolkitAuthInfo | null => {
      const auth = req.headers.authorization
      if (auth === 'Bearer admin-token') return { subject: 'u1', scopes: ['greeter'] }
      if (auth === 'Bearer weak-token') return { subject: 'u2', scopes: [] }
      return null
    }
    server = await startHttpMcpServer({
      name: 'test',
      version: '1.0.0',
      tools: [greet],
      port: 0,
      authenticate,
      runtime: { guardrails: [defineScopeGuardrail({ required: { greet: ['greeter'] } })] }
    })

    const allowed = await connect(server, { authorization: 'Bearer admin-token' })
    const ok = await allowed.callTool({ name: 'greet', arguments: { name: 'Ada' } })
    expect(ok.isError).toBeFalsy()

    const denied = await connect(server, { authorization: 'Bearer weak-token' })
    const blocked = await denied.callTool({ name: 'greet', arguments: { name: 'Ada' } })
    expect(blocked.isError).toBe(true)
    const content = blocked.content as Array<{ text: string }>
    expect(content[0].text).toContain('GUARDRAIL_BLOCKED')
  })
})
