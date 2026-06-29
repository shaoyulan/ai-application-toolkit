import type { ToolDefinition } from '@ai-application-toolkit/tool'

export interface Capability {
  id: string
  description?: string
  tools: ToolDefinition[]
}

export function defineCapability(capability: Capability): Capability {
  return Object.freeze({
    ...capability,
    tools: Object.freeze([...capability.tools]) as unknown as ToolDefinition[]
  })
}
