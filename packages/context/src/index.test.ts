import { describe, expect, it } from 'vitest'
import { createContext } from './index'

describe('createContext', () => {
  it('freezes its data', () => {
    const ctx = createContext({ variables: { a: 1 } })
    expect(Object.isFrozen(ctx.data)).toBe(true)
  })

  it('merge produces a new context without mutating the original', () => {
    const base = createContext({ variables: { a: 1 }, metadata: { x: true } })
    const merged = base.merge({ variables: { b: 2 } })

    expect(merged).not.toBe(base)
    expect(base.data.variables).toEqual({ a: 1 })
    expect(merged.data.variables).toEqual({ a: 1, b: 2 })
    expect(merged.data.metadata).toEqual({ x: true })
  })

  it('merge overrides overlapping variable keys', () => {
    const merged = createContext({ variables: { a: 1 } }).merge({ variables: { a: 99 } })
    expect(merged.data.variables).toEqual({ a: 99 })
  })

  it('defaults to empty data', () => {
    expect(createContext().data).toEqual({})
  })

  it('deeply freezes nested data', () => {
    const ctx = createContext({ variables: { nested: { a: 1 } } })
    expect(Object.isFrozen(ctx.data.variables)).toBe(true)
    expect(Object.isFrozen((ctx.data.variables as { nested: object }).nested)).toBe(true)
    expect(() => {
      ;(ctx.data.variables as { nested: { a: number } }).nested.a = 2
    }).toThrow()
  })

  it('does not freeze the caller’s original top-level objects', () => {
    const variables = { a: 1 }
    createContext({ variables })
    expect(Object.isFrozen(variables)).toBe(false)
  })
})
