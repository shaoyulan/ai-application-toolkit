import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { ToolkitError, type JsonSchema } from '@ai-application-toolkit/core'
import { defineTool, type AnyToolDefinition } from '@ai-application-toolkit/tool'

/** How to reach the external MCP server. */
export type McpClientTransport =
  | { kind: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { kind: 'http'; url: string; headers?: Record<string, string> }

export interface McpClientOptions {
  transport: McpClientTransport
  clientInfo?: { name: string; version: string }
  /**
   * Prefix prepended to each remote tool id, e.g. `'github.'` → `github.create_issue`.
   * Prevents collisions when several MCP servers (or local tools) share names.
   */
  toolIdPrefix?: string
}

export interface McpClientHandle {
  /** Remote tools wrapped as toolkit tools — hand straight to `createRuntime({ tools })`. */
  tools: AnyToolDefinition[]
  /** Re-fetches the remote tool list (the server's tools may change at runtime). */
  listTools(): Promise<AnyToolDefinition[]>
  /** The underlying MCP SDK client, for advanced use (resources, prompts, …). */
  client: Client
  /** Closes the transport and the connection. */
  close(): Promise<void>
}

/** Reverses {@link toMcpContent}: turns an MCP tool result into a plain value,
 * and raises a tool error as a `ToolkitError` so the runtime treats it as a
 * normal execution failure. */
export function fromMcpContent(result: CallToolResult): unknown {
  const blocks = result.content ?? []
  const text = blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')

  if (result.isError) {
    throw new ToolkitError({
      code: 'MCP_TOOL_ERROR',
      message: text || 'Remote MCP tool reported an error'
    })
  }

  // Structured output, when the server provides it, is the most faithful value.
  if (result.structuredContent !== undefined) {
    return result.structuredContent
  }
  // A single text block is almost always the whole payload; return it directly.
  if (blocks.length === 1 && blocks[0].type === 'text') {
    return text
  }
  return blocks
}

function createTransport(config: McpClientTransport): Transport {
  if (config.kind === 'stdio') {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env
    })
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: config.headers ? { headers: config.headers } : undefined
  })
}

/** Wraps every remote tool as a toolkit tool whose `execute` calls back through
 * the MCP client. Running these through `createRuntime` means external tools get
 * the same input validation, guardrails, timeout, and tracing as local ones. */
async function loadTools(client: Client, prefix: string): Promise<AnyToolDefinition[]> {
  const { tools } = await client.listTools()
  return tools.map((remote) =>
    defineTool({
      id: `${prefix}${remote.name}`,
      ...(remote.description ? { description: remote.description } : {}),
      ...(remote.inputSchema ? { input: remote.inputSchema as unknown as JsonSchema } : {}),
      execute: async (input: Record<string, unknown>) => {
        const result = (await client.callTool({
          name: remote.name,
          arguments: input
        })) as CallToolResult
        return fromMcpContent(result)
      }
    })
  )
}

/**
 * Connects to an external MCP server and exposes its tools as toolkit tools.
 *
 * @example
 * const remote = await connectMcpClient({
 *   transport: { kind: 'stdio', command: 'my-mcp-server' },
 *   toolIdPrefix: 'remote.'
 * })
 * const runtime = createRuntime({ tools: remote.tools, guardrails })
 * // ... use runtime ...
 * await remote.close()
 */
export async function connectMcpClient(options: McpClientOptions): Promise<McpClientHandle> {
  const prefix = options.toolIdPrefix ?? ''
  const client = new Client(
    options.clientInfo ?? { name: 'ai-application-toolkit', version: '0.0.0' }
  )
  const transport = createTransport(options.transport)
  await client.connect(transport)

  const tools = await loadTools(client, prefix)

  return {
    tools,
    listTools: () => loadTools(client, prefix),
    client,
    close: () => client.close()
  }
}
