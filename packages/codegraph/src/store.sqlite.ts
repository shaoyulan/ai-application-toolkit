/**
 * Embedded-SQLite implementation of {@link GraphStore}.
 *
 * `better-sqlite3` is an optional dependency loaded via `createRequire` (as the
 * parser loads its wasm), so importing the base library never pulls in the
 * native module — only code that actually opens a store does. Use
 * {@link openSqliteStore} rather than constructing this directly; it lazy-loads
 * the driver and gives a clear error if the optional dep is missing.
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { ToolkitError } from '@ai-application-toolkit/core'
import type { EdgeKind, GraphNode, SerializedCodeGraph, SymbolKind } from './graph.js'
import type { FileFacts } from './parser.js'
import type { FileRecord, GraphStore, StoreMeta } from './store.js'

// Structural types for the bits of better-sqlite3 we use, so this file type-checks
// without a hard dependency on @types/better-sqlite3 at consumers.
type Statement = { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] }
type Database = {
  exec(sql: string): unknown
  prepare(sql: string): Statement
  transaction<T extends (...args: never[]) => unknown>(fn: T): T
  pragma(sql: string): unknown
  close(): void
}
type DatabaseConstructor = new (path: string) => Database

const require = createRequire(import.meta.url)

function loadDriver(): DatabaseConstructor {
  try {
    return require('better-sqlite3') as DatabaseConstructor
  } catch (cause) {
    throw new ToolkitError({
      code: 'CODEGRAPH_SQLITE_NOT_INSTALLED',
      message:
        'Persistent indexing requires the optional dependency "better-sqlite3" (npm i better-sqlite3)',
      cause
    })
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  language TEXT NOT NULL,
  hash TEXT NOT NULL,
  facts_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT,
  symbol_kind TEXT,
  path TEXT,
  start_line INTEGER,
  end_line INTEGER,
  language TEXT
);
CREATE TABLE IF NOT EXISTS edges (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  meta_json TEXT,
  PRIMARY KEY (from_id, to_id, kind)
);
CREATE INDEX IF NOT EXISTS edges_from ON edges (from_id);
CREATE INDEX IF NOT EXISTS edges_to ON edges (to_id);
CREATE INDEX IF NOT EXISTS edges_kind ON edges (kind);
`

/** SQLite-backed parse cache + resolved-graph store. */
export class SqliteGraphStore implements GraphStore {
  private readonly db: Database

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    const Database = loadDriver()
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  meta(): StoreMeta | undefined {
    const rows = this.db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]
    if (rows.length === 0) return undefined
    const map = new Map(rows.map((r) => [r.key, r.value]))
    const schemaVersion = Number(map.get('schemaVersion'))
    const treeSitterVersion = map.get('treeSitterVersion')
    const configHash = map.get('configHash')
    if (!Number.isFinite(schemaVersion) || treeSitterVersion === undefined || configHash === undefined) {
      return undefined
    }
    return { schemaVersion, treeSitterVersion, configHash }
  }

  setMeta(meta: StoreMeta): void {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    const tx = this.db.transaction((m: StoreMeta) => {
      stmt.run('schemaVersion', String(m.schemaVersion))
      stmt.run('treeSitterVersion', m.treeSitterVersion)
      stmt.run('configHash', m.configHash)
    })
    tx(meta)
  }

  getFileHashes(): Map<string, string> {
    const rows = this.db.prepare('SELECT path, hash FROM files').all() as { path: string; hash: string }[]
    return new Map(rows.map((r) => [r.path, r.hash]))
  }

  getFacts(paths: string[]): Map<string, FileRecord> {
    const result = new Map<string, FileRecord>()
    const stmt = this.db.prepare('SELECT path, language, hash, facts_json FROM files WHERE path = ?')
    for (const path of paths) {
      const row = stmt.get(path) as
        | { path: string; language: string; hash: string; facts_json: string }
        | undefined
      if (row) {
        result.set(row.path, {
          path: row.path,
          language: row.language,
          hash: row.hash,
          facts: JSON.parse(row.facts_json) as FileFacts
        })
      }
    }
    return result
  }

  putFacts(records: FileRecord[]): void {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO files (path, language, hash, facts_json) VALUES (?, ?, ?, ?)'
    )
    const tx = this.db.transaction((rows: FileRecord[]) => {
      for (const r of rows) stmt.run(r.path, r.language, r.hash, JSON.stringify(r.facts))
    })
    tx(records)
  }

  deleteFiles(paths: string[]): void {
    const stmt = this.db.prepare('DELETE FROM files WHERE path = ?')
    const tx = this.db.transaction((rows: string[]) => {
      for (const p of rows) stmt.run(p)
    })
    tx(paths)
  }

  saveGraph(graph: SerializedCodeGraph): void {
    const insertNode = this.db.prepare(
      `INSERT OR REPLACE INTO nodes (id, kind, name, symbol_kind, path, start_line, end_line, language)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insertEdge = this.db.prepare(
      'INSERT OR REPLACE INTO edges (from_id, to_id, kind, meta_json) VALUES (?, ?, ?, ?)'
    )
    const tx = this.db.transaction((g: SerializedCodeGraph) => {
      this.db.exec('DELETE FROM nodes; DELETE FROM edges;')
      for (const n of g.nodes) {
        if (n.kind === 'symbol') {
          insertNode.run(n.id, 'symbol', n.name, n.symbolKind, n.file, n.startLine, n.endLine, null)
        } else {
          insertNode.run(n.id, 'file', null, null, n.path, null, null, n.language)
        }
      }
      for (const e of g.edges) insertEdge.run(e.from, e.to, e.kind, null)
    })
    tx(graph)
  }

  loadGraph(): SerializedCodeGraph | undefined {
    const nodeRows = this.db.prepare('SELECT * FROM nodes').all() as NodeRow[]
    if (nodeRows.length === 0) return undefined
    const nodes: GraphNode[] = nodeRows.map((r) =>
      r.kind === 'symbol'
        ? {
            id: r.id,
            kind: 'symbol' as const,
            name: r.name ?? '',
            symbolKind: (r.symbol_kind ?? 'variable') as SymbolKind,
            file: r.path ?? '',
            startLine: r.start_line ?? 0,
            endLine: r.end_line ?? 0
          }
        : { id: r.id, kind: 'file' as const, path: r.path ?? '', language: r.language ?? '' }
    )
    const edgeRows = this.db.prepare('SELECT from_id, to_id, kind FROM edges').all() as {
      from_id: string
      to_id: string
      kind: string
    }[]
    const edges = edgeRows.map((e) => ({ from: e.from_id, to: e.to_id, kind: e.kind as EdgeKind }))
    return { nodes, edges }
  }

  close(): void {
    this.db.close()
  }
}

interface NodeRow {
  id: string
  kind: string
  name: string | null
  symbol_kind: string | null
  path: string | null
  start_line: number | null
  end_line: number | null
  language: string | null
}

/** Open (creating if needed) a SQLite-backed graph store at `dbPath`. */
export function openSqliteStore(dbPath: string): SqliteGraphStore {
  return new SqliteGraphStore(dbPath)
}
