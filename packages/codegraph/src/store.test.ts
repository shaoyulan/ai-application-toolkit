import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SerializedCodeGraph } from './graph.js'
import type { FileRecord, StoreMeta } from './store.js'
import { STORE_SCHEMA_VERSION } from './store.js'
import { SqliteGraphStore } from './store.sqlite.js'

const META: StoreMeta = {
  schemaVersion: STORE_SCHEMA_VERSION,
  treeSitterVersion: '0.26.10',
  configHash: 'abc'
}

const record = (path: string, hash: string): FileRecord => ({
  path,
  language: 'typescript',
  hash,
  facts: {
    definitions: [{ name: 'foo', kind: 'function', startLine: 1, endLine: 3, startIndex: 0, endIndex: 20 }],
    references: [{ name: 'bar', startIndex: 10 }],
    imports: [{ raw: './bar' }]
  }
})

describe('SqliteGraphStore', () => {
  let dir: string
  let store: SqliteGraphStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cg-store-'))
    store = new SqliteGraphStore(join(dir, '.codegraph', 'index.db'))
  })

  afterEach(async () => {
    store.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('starts empty', () => {
    expect(store.meta()).toBeUndefined()
    expect(store.getFileHashes().size).toBe(0)
    expect(store.loadGraph()).toBeUndefined()
  })

  it('round-trips meta', () => {
    store.setMeta(META)
    expect(store.meta()).toEqual(META)
  })

  it('round-trips file facts and hashes', () => {
    store.putFacts([record('a.ts', 'h1'), record('b.ts', 'h2')])
    expect(store.getFileHashes()).toEqual(new Map([['a.ts', 'h1'], ['b.ts', 'h2']]))
    const facts = store.getFacts(['a.ts', 'missing.ts'])
    expect(facts.get('a.ts')?.facts.definitions[0].name).toBe('foo')
    expect(facts.has('missing.ts')).toBe(false)
  })

  it('overwrites facts on re-put (same path)', () => {
    store.putFacts([record('a.ts', 'h1')])
    store.putFacts([record('a.ts', 'h2')])
    expect(store.getFileHashes().get('a.ts')).toBe('h2')
  })

  it('deletes files', () => {
    store.putFacts([record('a.ts', 'h1'), record('b.ts', 'h2')])
    store.deleteFiles(['a.ts'])
    expect([...store.getFileHashes().keys()]).toEqual(['b.ts'])
  })

  it('round-trips the resolved graph', () => {
    const graph: SerializedCodeGraph = {
      nodes: [
        { id: 'file:a.ts', kind: 'file', path: 'a.ts', language: 'typescript' },
        { id: 'sym:a.ts#foo@1', kind: 'symbol', name: 'foo', symbolKind: 'function', file: 'a.ts', startLine: 1, endLine: 3 }
      ],
      edges: [{ from: 'file:a.ts', to: 'sym:a.ts#foo@1', kind: 'contains' }]
    }
    store.saveGraph(graph)
    const loaded = store.loadGraph()
    expect(loaded?.nodes).toEqual(expect.arrayContaining(graph.nodes))
    expect(loaded?.nodes).toHaveLength(2)
    expect(loaded?.edges).toEqual(graph.edges)
  })

  it('replaces the graph on re-save', () => {
    store.saveGraph({ nodes: [{ id: 'file:a.ts', kind: 'file', path: 'a.ts', language: 'typescript' }], edges: [] })
    store.saveGraph({ nodes: [{ id: 'file:b.ts', kind: 'file', path: 'b.ts', language: 'typescript' }], edges: [] })
    const loaded = store.loadGraph()
    expect(loaded?.nodes.map((n) => n.id)).toEqual(['file:b.ts'])
  })
})
