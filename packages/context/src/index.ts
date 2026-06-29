export interface ToolkitContextData {
  history?: unknown[]
  documents?: unknown[]
  variables?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface ToolkitContext {
  readonly data: Readonly<ToolkitContextData>
  merge(data: ToolkitContextData): ToolkitContext
}

export function createContext(data: ToolkitContextData = {}): ToolkitContext {
  const frozen = Object.freeze({ ...data })

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
