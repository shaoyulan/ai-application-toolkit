import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryCache } from './index'

describe('createMemoryCache', () => {
  it('stores and retrieves values by key', async () => {
    const cache = createMemoryCache<number>()
    await cache.set('a', 1)
    expect(await cache.get('a')).toBe(1)
  })

  it('returns undefined for missing keys', async () => {
    const cache = createMemoryCache()
    expect(await cache.get('missing')).toBeUndefined()
  })

  it('overwrites an existing key', async () => {
    const cache = createMemoryCache<string>()
    await cache.set('k', 'first')
    await cache.set('k', 'second')
    expect(await cache.get('k')).toBe('second')
  })

  it('supports has, delete and clear', async () => {
    const cache = createMemoryCache<number>()
    await cache.set('a', 1)
    expect(await cache.has('a')).toBe(true)
    expect(await cache.has('b')).toBe(false)

    await cache.delete('a')
    expect(await cache.has('a')).toBe(false)

    await cache.set('x', 1)
    await cache.set('y', 2)
    await cache.clear()
    expect(await cache.has('x')).toBe(false)
    expect(await cache.has('y')).toBe(false)
  })

  describe('maxSize (LRU)', () => {
    it('evicts the least-recently-used entry past maxSize', async () => {
      const cache = createMemoryCache<number>({ maxSize: 2 })
      await cache.set('a', 1)
      await cache.set('b', 2)
      await cache.set('c', 3) // evicts 'a'

      expect(await cache.has('a')).toBe(false)
      expect(await cache.get('b')).toBe(2)
      expect(await cache.get('c')).toBe(3)
    })

    it('treats get as a recency bump', async () => {
      const cache = createMemoryCache<number>({ maxSize: 2 })
      await cache.set('a', 1)
      await cache.set('b', 2)
      await cache.get('a') // 'a' is now most-recently-used
      await cache.set('c', 3) // evicts 'b', not 'a'

      expect(await cache.has('a')).toBe(true)
      expect(await cache.has('b')).toBe(false)
    })
  })

  describe('ttlMs', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('expires entries after the ttl', async () => {
      const cache = createMemoryCache<number>({ ttlMs: 1000 })
      await cache.set('a', 1)
      expect(await cache.get('a')).toBe(1)

      vi.advanceTimersByTime(1001)
      expect(await cache.get('a')).toBeUndefined()
      expect(await cache.has('a')).toBe(false)
    })

    it('keeps entries that have not yet expired', async () => {
      const cache = createMemoryCache<number>({ ttlMs: 1000 })
      await cache.set('a', 1)
      vi.advanceTimersByTime(500)
      expect(await cache.get('a')).toBe(1)
    })
  })
})
