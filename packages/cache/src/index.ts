export interface CacheStore<T = unknown> {
  get(key: string): Promise<T | undefined> | T | undefined
  set(key: string, value: T): Promise<void> | void
}

export function createMemoryCache<T = unknown>(): CacheStore<T> {
  const map = new Map<string, T>()

  return {
    get: (key) => map.get(key),
    set: (key, value) => {
      map.set(key, value)
    }
  }
}
