import { describe, expect, it } from 'vitest'
import { defineCapability, collectCapabilityTools } from './index'

describe('defineCapability', () => {
  it('freezes the capability and its tools', () => {
    const tool = { id: 'a', execute: () => 1 }
    const capability = defineCapability({ id: 'cap', tools: [tool] })

    expect(Object.isFrozen(capability)).toBe(true)
    expect(Object.isFrozen(capability.tools)).toBe(true)
    expect(capability.id).toBe('cap')
    expect(capability.tools).toHaveLength(1)
  })

  it('copies the tools array so external mutation does not leak in', () => {
    const tools = [{ id: 'a', execute: () => 1 }]
    const capability = defineCapability({ id: 'cap', tools })
    tools.push({ id: 'b', execute: () => 2 })
    expect(capability.tools).toHaveLength(1)
  })
})

describe('collectCapabilityTools', () => {
  it('flattens tools from multiple capabilities in order', () => {
    const a = defineCapability({ id: 'a', tools: [{ id: 't1', execute: () => 1 }] })
    const b = defineCapability({
      id: 'b',
      tools: [
        { id: 't2', execute: () => 2 },
        { id: 't3', execute: () => 3 }
      ]
    })

    const tools = collectCapabilityTools([a, b])
    expect(tools.map((t) => t.id)).toEqual(['t1', 't2', 't3'])
  })

  it('throws CAPABILITY_TOOL_CONFLICT on duplicate tool ids across capabilities', () => {
    const a = defineCapability({ id: 'a', tools: [{ id: 'dup', execute: () => 1 }] })
    const b = defineCapability({ id: 'b', tools: [{ id: 'dup', execute: () => 2 }] })

    expect(() => collectCapabilityTools([a, b])).toThrowError(
      /Tool id "dup" is provided by both "a" and "b"/
    )
  })

  it('returns an empty list for no capabilities', () => {
    expect(collectCapabilityTools([])).toEqual([])
  })
})
