import type { Awaitable } from '@ai-application-toolkit/core'

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  id: string
  description?: string
  input?: unknown
  execute: (input: TInput) => Awaitable<TOutput>
}

export function defineTool<TInput, TOutput>(
  definition: ToolDefinition<TInput, TOutput>
): ToolDefinition<TInput, TOutput> {
  return Object.freeze(definition)
}

export interface ToolRegistry {
  list(): ToolDefinition[]
  get(id: string): ToolDefinition | undefined
  register(tool: ToolDefinition): void
}

export function createToolRegistry(tools: ToolDefinition[] = []): ToolRegistry {
  const map = new Map<string, ToolDefinition>()

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
