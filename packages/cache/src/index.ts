export interface CacheStore<T = unknown> {
  get(key: string): Promise<T | undefined> | T | undefined
  set(key: string, value: T): Promise<void> | void
  has(key: string): Promise<boolean> | boolean
  delete(key: string): Promise<void> | void
  clear(): Promise<void> | void
}

export interface MemoryCacheOptions {
  /**
   * Maximum number of entries to retain. Once exceeded, the least-recently-used
   * entry is evicted. Omit for an unbounded cache.
   */
  maxSize?: number
  /**
   * Time-to-live in milliseconds. Entries are treated as missing once expired
   * and removed lazily on access. Omit for entries that never expire.
   */
  ttlMs?: number
}

interface Entry<T> {
  value: T
  expiresAt: number
}

export function createMemoryCache<T = unknown>(
  options: MemoryCacheOptions = {}
): CacheStore<T> {
  const { maxSize, ttlMs } = options
  // Map preserves insertion order, which gives us LRU ordering for free:
  // the first key is the least-recently-used.
  const map = new Map<string, Entry<T>>()

  function readFresh(key: string): Entry<T> | undefined {
    const entry = map.get(key)
    if (!entry) {
      return undefined
    }
    if (entry.expiresAt <= Date.now()) {
      map.delete(key)
      return undefined
    }
    return entry
  }

  return {
    get(key) {
      const entry = readFresh(key)
      if (!entry) {
        return undefined
      }
      // Re-insert to mark this key as most-recently-used.
      map.delete(key)
      map.set(key, entry)
      return entry.value
    },
    set(key, value) {
      map.delete(key)
      map.set(key, {
        value,
        expiresAt: ttlMs !== undefined ? Date.now() + ttlMs : Infinity
      })
      if (maxSize !== undefined && map.size > maxSize) {
        const oldest = map.keys().next().value
        if (oldest !== undefined) {
          map.delete(oldest)
        }
      }
    },
    has(key) {
      return readFresh(key) !== undefined
    },
    delete(key) {
      map.delete(key)
    },
    clear() {
      map.clear()
    }
  }
}
