import { mkdtemp, rm, writeFile, unlink, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildCodeGraph, loadCodeGraph, type BuildStats } from './build.js'
import type { SerializedCodeGraph } from './graph.js'
import { SqliteGraphStore } from './store.sqlite.js'

/** Sort nodes/edges so two builds can be compared regardless of insertion order. */
function normalize(graph: SerializedCodeGraph) {
  return {
    nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...graph.edges]
      .map((e) => `${e.kind}:${e.from}->${e.to}`)
      .sort()
  }
}

describe('incremental build', () => {
  let dir: string
  let store: SqliteGraphStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cg-build-'))
    await writeFile(join(dir, 'a.ts'), 'export function a() { return b() }\n')
    await writeFile(join(dir, 'b.ts'), 'export function b() { return 1 }\n')
    store = new SqliteGraphStore(join(dir, '.codegraph', 'index.db'))
  })

  afterEach(async () => {
    store.close()
    await rm(dir, { recursive: true, force: true })
  })

  const build = async () => {
    let stats: BuildStats | undefined
    const graph = await buildCodeGraph({ dir, store, onStats: (s) => (stats = s) })
    return { graph, stats: stats! }
  }

  it('parses everything on the first build, reuses on the second', async () => {
    const first = await build()
    expect(first.stats).toMatchObject({ files: 2, parsed: 2, reused: 0, deleted: 0 })

    const second = await build()
    expect(second.stats).toMatchObject({ files: 2, parsed: 0, reused: 2, deleted: 0 })
  })

  it('re-parses only the changed file', async () => {
    await build()
    await writeFile(join(dir, 'a.ts'), 'export function a() { return b() + 1 }\n')
    const { stats } = await build()
    expect(stats).toMatchObject({ parsed: 1, reused: 1, deleted: 0 })
  })

  it('does not re-parse when only mtime changes (identical content)', async () => {
    await build()
    const future = new Date(Date.now() + 10_000)
    await utimes(join(dir, 'a.ts'), future, future) // touch: new mtime, same bytes
    const { stats } = await build()
    expect(stats).toMatchObject({ parsed: 0, reused: 2 })
  })

  it('persistGraph:false updates facts but leaves the stored graph untouched', async () => {
    await build()
    const before = store.loadGraph()
    await writeFile(join(dir, 'a.ts'), 'export function a() { return b() + 99 }\n')
    let stats: BuildStats | undefined
    await buildCodeGraph({ dir, store, persistGraph: false, onStats: (s) => (stats = s) })
    expect(stats).toMatchObject({ parsed: 1, reused: 1 }) // facts were updated
    expect(store.loadGraph()).toEqual(before) // but the persisted graph is unchanged
  })

  it('drops deleted files from the cache and graph', async () => {
    await build()
    await unlink(join(dir, 'b.ts'))
    const { graph, stats } = await build()
    expect(stats).toMatchObject({ parsed: 0, reused: 1, deleted: 1 })
    expect(graph.getNode('file:b.ts')).toBeUndefined()
    expect(store.getFileHashes().has('b.ts')).toBe(false)
  })

  it('produces the same graph as a cold in-memory build', async () => {
    const incremental = (await build()).graph
    const cold = await buildCodeGraph({ dir })
    expect(normalize(incremental.toJSON())).toEqual(normalize(cold.toJSON()))
  })

  it('persists the resolved graph for instant reload', async () => {
    const { graph } = await build()
    const reloaded = store.loadGraph()
    expect(reloaded).toBeDefined()
    expect(normalize(reloaded!)).toEqual(normalize(graph.toJSON()))
  })

  it('cold-rebuilds when the config hash changes', async () => {
    await build()
    // A language filter changes the config hash → cache invalidated.
    let stats: BuildStats | undefined
    await buildCodeGraph({ dir, store, languages: ['typescript'], onStats: (s) => (stats = s) })
    expect(stats).toMatchObject({ parsed: 2, reused: 0 })
  })

  it('loadCodeGraph reopens the persisted graph without re-walking', async () => {
    const built = (await build()).graph
    const reopened = await loadCodeGraph(store)
    expect(reopened).toBeDefined()
    expect(normalize(reopened!.toJSON())).toEqual(normalize(built.toJSON()))
  })

  it('excludes files over maxFileBytes with no dangling nodes or edges', async () => {
    await writeFile(join(dir, 'big.ts'), `export function big() { return ${'0'.repeat(5000)} }\n`)
    await writeFile(join(dir, 'importer.ts'), "import { big } from './big'\nexport const x = big\n")
    const graph = await buildCodeGraph({ dir, maxFileBytes: 500 })
    // big.ts exceeds the limit → no file node and no edge points at it.
    expect(graph.getNode('file:big.ts')).toBeUndefined()
    expect(graph.edges().some((e) => e.to === 'file:big.ts')).toBe(false)
  })
})
