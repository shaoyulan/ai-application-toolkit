import type { Awaitable, JsonSchema, ToolkitExecutionContext } from '@ai-application-toolkit/core'

export * from './schema.js'

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  id: string
  description?: string
  /**
   * JSON Schema for the tool input. When present, the runtime validates the
   * input against it before execution, and it can be exported to tool-calling
   * APIs (Claude, MCP) that expect an input schema.
   */
  input?: JsonSchema
  /**
   * Executes the tool. The runtime passes the immutable run context as the
   * second argument; tools that don't need it can ignore it.
   */
  execute: (input: TInput, context?: ToolkitExecutionContext) => Awaitable<TOutput>
}

export function defineTool<TInput, TOutput>(
  definition: ToolDefinition<TInput, TOutput>
): ToolDefinition<TInput, TOutput> {
  return Object.freeze(definition)
}

/**
 * Tool type for heterogeneous collections (registries, runtime options,
 * capabilities). `any` is intentional here (AGENTS.md coding style): a
 * collection holds tools with differing input/output types, and because
 * `execute` is contravariant in its input, the per-tool `ToolDefinition<X, Y>`
 * is not assignable to `ToolDefinition<unknown, unknown>`. Using `any` for the
 * collection element lets typed tools from `defineTool` be stored without
 * forcing callers to widen or cast. Per-tool type safety is preserved at the
 * `defineTool` call site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>

export interface ToolRegistry {
  list(): AnyToolDefinition[]
  get(id: string): AnyToolDefinition | undefined
  register(tool: AnyToolDefinition): void
}

export function createToolRegistry(tools: AnyToolDefinition[] = []): ToolRegistry {
  const map = new Map<string, AnyToolDefinition>()

  for (const tool of tools) {
    map.set(tool.id, tool)
  }

  return {
    list: () => [...map.values()],
    get: (id) => map.get(id),
    register: (tool) => {
      if (map.has(tool.id)) {
        throw new Error(`Tool already registered: ${tool.id}`)
      }
      map.set(tool.id, tool)
    }
  }
}
