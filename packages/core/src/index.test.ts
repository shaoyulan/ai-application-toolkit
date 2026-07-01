import { describe, expect, it } from 'vitest'
import { ToolkitError } from './index'

describe('ToolkitError', () => {
  it('carries the code and message', () => {
    const error = new ToolkitError({ code: 'BOOM', message: 'it broke' })
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('ToolkitError')
    expect(error.code).toBe('BOOM')
    expect(error.message).toBe('it broke')
  })

  it('preserves the underlying cause', () => {
    const cause = new Error('root cause')
    const error = new ToolkitError({ code: 'WRAPPED', message: 'wrapped', cause })
    expect(error.cause).toBe(cause)
  })
})
