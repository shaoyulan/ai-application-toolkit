import { describe, expect, it } from 'vitest'
import { createDebouncer, isIgnoredPath } from './watch.js'

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('isIgnoredPath', () => {
  const ignore = new Set(['node_modules', '.codegraph'])

  it('ignores paths with an ignored segment', () => {
    expect(isIgnoredPath('node_modules/x.ts', ignore)).toBe(true)
    expect(isIgnoredPath('a/.codegraph/index.db', ignore)).toBe(true)
    expect(isIgnoredPath('pkg\\node_modules\\x.ts', ignore)).toBe(true) // windows sep
  })

  it('allows other paths and null', () => {
    expect(isIgnoredPath('src/a.ts', ignore)).toBe(false)
    expect(isIgnoredPath(null, ignore)).toBe(false)
  })
})

describe('createDebouncer', () => {
  it('coalesces a burst of triggers into one flush', async () => {
    let flushes = 0
    const d = createDebouncer(30, () => void flushes++)
    d.trigger()
    d.trigger()
    d.trigger()
    await wait(80)
    expect(flushes).toBe(1)
  })

  it('cancel() prevents a pending flush', async () => {
    let flushes = 0
    const d = createDebouncer(30, () => void flushes++)
    d.trigger()
    d.cancel()
    await wait(80)
    expect(flushes).toBe(0)
  })

  it('routes flush errors to onError', async () => {
    const errors: unknown[] = []
    const d = createDebouncer(
      20,
      () => {
        throw new Error('boom')
      },
      (e) => errors.push(e)
    )
    d.trigger()
    await wait(60)
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe('boom')
  })

  it('queues exactly one follow-up for a trigger during an in-flight flush', async () => {
    let started = 0
    const d = createDebouncer(20, async () => {
      started++
      await wait(60) // still running when the next trigger arrives
    })
    d.trigger()
    await wait(40) // first flush now running
    d.trigger() // arrives mid-flush -> should queue one follow-up
    d.trigger()
    await wait(200)
    expect(started).toBe(2)
  })
})
