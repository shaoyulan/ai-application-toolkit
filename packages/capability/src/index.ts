import { ToolkitError } from '@ai-application-toolkit/core'
import type { AnyToolDefinition } from '@ai-application-toolkit/tool'

export interface Capability {
  id: string
  description?: string
  tools: AnyToolDefinition[]
}

export function defineCapability(capability: Capability): Capability {
  return Object.freeze({
    ...capability,
    tools: Object.freeze([...capability.tools]) as unknown as AnyToolDefinition[]
  })
}

/**
 * Flattens one or more capabilities into a single tool list ready to hand to
 * `createRuntime({ tools })`. Throws if two capabilities expose tools with the
 * same id, since the runtime requires unique tool ids.
 */
export function collectCapabilityTools(
  capabilities: Capability[]
): AnyToolDefinition[] {
  const byId = new Map<string, string>() // toolId -> owning capability id
  const tools: AnyToolDefinition[] = []

  for (const capability of capabilities) {
    for (const tool of capability.tools) {
      const owner = byId.get(tool.id)
      if (owner !== undefined) {
        throw new ToolkitError({
          code: 'CAPABILITY_TOOL_CONFLICT',
          message: `Tool id "${tool.id}" is provided by both "${owner}" and "${capability.id}"`
        })
      }
      byId.set(tool.id, capability.id)
      tools.push(tool)
    }
  }

  return tools
}
