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
