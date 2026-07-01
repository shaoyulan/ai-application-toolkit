import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool as McpTool
} from '@modelcontextprotocol/sdk/types.js'
import { ToolkitError } from '@ai-application-toolkit/core'
import type { ToolkitContextData } from '@ai-application-toolkit/core'
import { createRuntime, type RuntimeOptions } from '@ai-application-toolkit/runtime'
import type { AnyToolDefinition } from '@ai-application-toolkit/tool'

export type Runtime = ReturnType<typeof createRuntime>

export interface CreateMcpServerOptions {
  name: string
  version: string
  /** Tools to expose over MCP. */
  tools: AnyToolDefinition[]
  /** Extra runtime configuration (guardrails, context, trace, timeout). */
  runtime?: Omit<RuntimeOptions, 'tools'>
}

const EMPTY_OBJECT_SCHEMA = { type: 'object', properties: {} } as const

/** Converts a toolkit tool definition into an MCP tool descriptor. */
export function toolToMcp(tool: AnyToolDefinition): McpTool {
  return {
    name: tool.id,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: (tool.input ?? EMPTY_OBJECT_SCHEMA) as unknown as McpTool['inputSchema']
  }
}

/** Wraps a tool's output in an MCP text content block. */
export function toMcpContent(output: unknown): CallToolResult {
  const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2)
  return { content: [{ type: 'text', text }] }
}

export async function callTool(
  runtime: Runtime,
  name: string,
  args: Record<string, unknown> | undefined,
  context?: ToolkitContextData
): Promise<CallToolResult> {
  try {
    const output = await runtime.executeTool({ toolId: name, input: args ?? {}, context })
    return toMcpContent(output)
  } catch (error) {
    // Surface execution failures to the model as tool errors, not protocol
    // errors, per the MCP convention.
    const message =
      error instanceof ToolkitError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error)
    return { content: [{ type: 'text', text: message }], isError: true }
  }
}

/**
 * Builds an MCP {@link Server} bound to an existing runtime. Each HTTP request
 * in stateless mode gets its own short-lived server from this, while sharing the
 * one runtime — so guardrails, validation, context, and tracing stay consistent.
 * `contextFor` lets a transport inject per-request context (e.g. the
 * authenticated caller) into every `tools/call`.
 */
export function buildMcpServer(
  options: CreateMcpServerOptions,
  runtime: Runtime,
  contextFor?: () => ToolkitContextData | undefined
): Server {
  const server = new Server(
    { name: options.name, version: options.version },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.tools.map(toolToMcp)
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(runtime, request.params.name, request.params.arguments, contextFor?.())
  )

  return server
}

/**
 * Builds an MCP {@link Server} that exposes the given toolkit tools. Tool input
 * schemas are forwarded as MCP `inputSchema`, and `tools/call` runs through the
 * toolkit runtime — so guardrails, input validation, context, and tracing all
 * apply.
 */
export function createMcpServer(options: CreateMcpServerOptions): Server {
  const runtime = createRuntime({ tools: options.tools, ...options.runtime })
  return buildMcpServer(options, runtime)
}

/**
 * Convenience: builds the server and connects it over stdio — the transport
 * used by most local MCP clients (Claude Desktop, Claude Code, etc.).
 */
export async function startStdioMcpServer(
  options: CreateMcpServerOptions
): Promise<Server> {
  const server = createMcpServer(options)
  await server.connect(new StdioServerTransport())
  return server
}
