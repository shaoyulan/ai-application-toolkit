export type Awaitable<T> = T | Promise<T>

export interface ToolkitErrorShape {
  code: string
  message: string
  cause?: unknown
}

export class ToolkitError extends Error {
  readonly code: string
  readonly cause?: unknown

  constructor(error: ToolkitErrorShape) {
    super(error.message)
    this.name = 'ToolkitError'
    this.code = error.code
    this.cause = error.cause
  }
}

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type JsonSchemaType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null'

/**
 * Pragmatic JSON Schema subset used to describe tool inputs. Compatible with
 * the shape MCP and most LLM tool-calling APIs expect. Unlisted keywords are
 * allowed via the index signature but not enforced by the built-in validator.
 */
export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: JsonValue[]
  additionalProperties?: boolean | JsonSchema
  description?: string
  [keyword: string]: unknown
}

/**
 * Authenticated caller identity for a single run. Transport boundaries (e.g.
 * the MCP HTTP server) verify a bearer token and place the result here, on
 * `ToolkitContextData.metadata.auth`, so guardrails can make authorization
 * decisions (see `defineScopeGuardrail`).
 */
export interface ToolkitAuthInfo {
  subject?: string
  scopes?: string[]
  claims?: Record<string, unknown>
}

export interface ToolkitContextMetadata {
  auth?: ToolkitAuthInfo
  [key: string]: unknown
}

export interface ToolkitContextData {
  history?: unknown[]
  documents?: unknown[]
  variables?: Record<string, unknown>
  metadata?: ToolkitContextMetadata
}

/**
 * Read-only view of the context handed to a tool during a single execution
 * run. Context is immutable for the duration of a run (AGENTS.md rule 5), so
 * tools only ever receive this read-only shape. The concrete, mergeable
 * `ToolkitContext` lives in `@ai-application-toolkit/context`.
 */
export interface ToolkitExecutionContext {
  readonly data: Readonly<ToolkitContextData>
  /**
   * Aborted when the run times out or the caller cancels. Long-running tools
   * should observe this to stop cooperatively; the runtime also enforces it.
   */
  readonly signal?: AbortSignal
}
