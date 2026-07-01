import type { ToolkitContextData, ToolkitExecutionContext } from '@ai-application-toolkit/core'

export type { ToolkitContextData }

export interface ToolkitContext extends ToolkitExecutionContext {
  merge(data: ToolkitContextData): ToolkitContext
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

export function createContext(data: ToolkitContextData = {}): ToolkitContext {
  // Copy the top-level containers first so freezing never mutates the caller's
  // own `variables`/`metadata`/`history`/`documents` objects, then freeze
  // recursively for true run-scoped immutability (AGENTS.md rule 5).
  const snapshot: ToolkitContextData = { ...data }
  if (data.variables) snapshot.variables = { ...data.variables }
  if (data.metadata) snapshot.metadata = { ...data.metadata }
  if (data.history) snapshot.history = [...data.history]
  if (data.documents) snapshot.documents = [...data.documents]
  const frozen = deepFreeze(snapshot) as Readonly<ToolkitContextData>

  return {
    data: frozen,
    merge(next) {
      return createContext({
        ...frozen,
        ...next,
        variables: { ...frozen.variables, ...next.variables },
        metadata: { ...frozen.metadata, ...next.metadata }
      })
    }
  }
}
