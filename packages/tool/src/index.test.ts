import { describe, expect, it } from 'vitest'
import { defineTool, createToolRegistry, validateInput } from './index'

describe('defineTool', () => {
  it('returns a frozen definition', () => {
    const tool = defineTool({ id: 'echo', execute: (input: string) => input })
    expect(Object.isFrozen(tool)).toBe(true)
    expect(tool.id).toBe('echo')
  })
})

describe('createToolRegistry', () => {
  it('lists and gets tools provided at construction', () => {
    const a = defineTool({ id: 'a', execute: () => 1 })
    const b = defineTool({ id: 'b', execute: () => 2 })
    const registry = createToolRegistry([a, b])

    expect(registry.list()).toHaveLength(2)
    expect(registry.get('a')).toBe(a)
    expect(registry.get('missing')).toBeUndefined()
  })

  it('registers new tools', () => {
    const registry = createToolRegistry()
    const tool = defineTool({ id: 'new', execute: () => 'ok' })
    registry.register(tool)
    expect(registry.get('new')).toBe(tool)
  })

  it('throws when registering a duplicate id', () => {
    const registry = createToolRegistry([defineTool({ id: 'dup', execute: () => 1 })])
    expect(() => registry.register(defineTool({ id: 'dup', execute: () => 2 }))).toThrow(
      /already registered/
    )
  })
})

describe('validateInput', () => {
  const schema = {
    type: 'object' as const,
    properties: {
      name: { type: 'string' as const },
      age: { type: 'integer' as const },
      role: { type: 'string' as const, enum: ['admin', 'user'] }
    },
    required: ['name'],
    additionalProperties: false
  }

  it('accepts a valid object', () => {
    expect(validateInput(schema, { name: 'Ada', age: 30, role: 'admin' }).valid).toBe(true)
  })

  it('flags a missing required property', () => {
    const result = validateInput(schema, { age: 1 })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path === '/name')).toBe(true)
  })

  it('flags a type mismatch with a path', () => {
    const result = validateInput(schema, { name: 'Ada', age: 'old' })
    expect(result.valid).toBe(false)
    expect(result.errors).toContainEqual(
      expect.objectContaining({ path: '/age' })
    )
  })

  it('rejects values outside an enum', () => {
    expect(validateInput(schema, { name: 'Ada', role: 'root' }).valid).toBe(false)
  })

  it('rejects additional properties when additionalProperties is false', () => {
    const result = validateInput(schema, { name: 'Ada', extra: true })
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.path === '/extra')).toBe(true)
  })

  it('treats integers as valid numbers but not vice versa', () => {
    expect(validateInput({ type: 'number' }, 3).valid).toBe(true)
    expect(validateInput({ type: 'integer' }, 3.5).valid).toBe(false)
  })

  it('validates array items', () => {
    const arraySchema = { type: 'array' as const, items: { type: 'string' as const } }
    expect(validateInput(arraySchema, ['a', 'b']).valid).toBe(true)
    expect(validateInput(arraySchema, ['a', 2]).valid).toBe(false)
  })

  it('accepts type unions', () => {
    const unionSchema = { type: ['string', 'null'] as const }
    expect(validateInput({ ...unionSchema, type: ['string', 'null'] }, null).valid).toBe(true)
    expect(validateInput({ ...unionSchema, type: ['string', 'null'] }, 5).valid).toBe(false)
  })
})
