/**
 * Embedded-SQLite implementation of {@link GraphStore}.
 *
 * The SQLite driver is chosen at runtime so persistence works with **zero
 * install** on modern Node:
 *   1. `better-sqlite3` if it is installed (stable, no experimental warning);
 *   2. otherwise Node's built-in `node:sqlite` (Node ≥ 23.4, no dependency);
 *   3. otherwise a clear error (older Node without better-sqlite3).
 *
 * Both are loaded lazily via `createRequire`, so importing the base library
 * never pulls in a native module. Use {@link openSqliteStore} rather than
 * constructing this directly.
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { ToolkitError } from '@ai-application-toolkit/core'
import type { EdgeKind, GraphNode, SerializedCodeGraph, SymbolKind } from './graph.js'
import type { FileFacts } from './parser.js'
import type { FileRecord, GraphCommit, GraphStore, StoreMeta } from './store.js'

const require = createRequire(import.meta.url)

/** Minimal, driver-agnostic SQL surface used by the store. */
interface SqlStatement {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): Record<string, unknown> | undefined
  all(...params: unknown[]): Record<string, unknown>[]
}
interface SqlDb {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
  /** Wrap `fn` so its writes commit atomically (rollback on throw). */
  transaction<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void
  close(): void
}

/** Backend id, for observability. */
export type SqliteDriver = 'better-sqlite3' | 'node:sqlite'

/** A function that opens a DB file, or `undefined` if the driver isn't installed. */
type DriverLoader = ((path: string) => SqlDb) | undefined

function betterSqliteLoader(): DriverLoader {
  let Database: new (p: string) => {
    exec(sql: string): unknown
    prepare(sql: string): SqlStatement
    transaction<T extends (...a: never[]) => unknown>(fn: T): T
    close(): void
  }
  try {
    Database = require('better-sqlite3')
  } catch {
    return undefined // not installed
  }
  return (path) => {
    const db = new Database(path)
    db.exec('PRAGMA journal_mode = WAL')
    return {
      exec: (sql) => void db.exec(sql),
      prepare: (sql) => db.prepare(sql),
      transaction: (fn) => db.transaction(fn as never) as never,
      close: () => db.close()
    }
  }
}

/** Load a module with the "SQLite is an experimental feature" warning muted,
 * restoring `process.emitWarning` immediately so no global patch leaks. */
function requireQuietly<T>(id: string): T {
  const original = process.emitWarning
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const message = typeof warning === 'string' ? warning : (warning?.message ?? '')
    if (message.includes('SQLite is an experimental feature')) return
    return (original as (...a: unknown[]) => void).call(process, warning, ...args)
  }) as typeof process.emitWarning
  try {
    return require(id) as T
  } finally {
    process.emitWarning = original
  }
}

function nodeSqliteLoader(): DriverLoader {
  let DatabaseSync: new (p: string) => {
    exec(sql: string): unknown
    prepare(sql: string): SqlStatement
    close(): void
  }
  try {
    ;({ DatabaseSync } = requireQuietly<{ DatabaseSync: typeof DatabaseSync }>('node:sqlite'))
  } catch {
    return undefined // built-in not available (Node < 23.4, or flag required)
  }
  return (path) => {
    const db = new DatabaseSync(path)
    const exec = (sql: string) => void db.exec(sql)
    exec('PRAGMA journal_mode = WAL')
    return {
      exec,
      prepare: (sql) => db.prepare(sql),
      transaction:
        (fn) =>
        (...args) => {
          exec('BEGIN')
          try {
            fn(...args)
            exec('COMMIT')
          } catch (error) {
            exec('ROLLBACK')
            throw error
          }
        },
      close: () => db.close()
    }
  }
}

/**
 * Open a SQLite database, preferring an installed better-sqlite3 over the
 * built-in node:sqlite. Set `CODEGRAPH_SQLITE_DRIVER=node` to force the built-in
 * (skip the native module) or `=better` to require better-sqlite3.
 *
 * Distinguishes "no driver installed" from "driver works but this file can't be
 * opened" (a non-SQLite or corrupt file), so each gets an actionable message.
 */
function openDb(path: string): { db: SqlDb; driver: SqliteDriver } {
  const forced = process.env.CODEGRAPH_SQLITE_DRIVER
  const candidates: { driver: SqliteDriver; load: DriverLoader }[] = [
    { driver: 'better-sqlite3', load: forced === 'node' ? undefined : betterSqliteLoader() },
    { driver: 'node:sqlite', load: forced === 'better' ? undefined : nodeSqliteLoader() }
  ]
  const chosen = candidates.find((c) => c.load)
  if (!chosen) {
    throw new ToolkitError({
      code: 'CODEGRAPH_SQLITE_NOT_AVAILABLE',
      message:
        'Persistent indexing needs Node >= 23.4 (built-in node:sqlite) or the optional dependency "better-sqlite3" (npm i better-sqlite3).'
    })
  }
  try {
    return { db: chosen.load!(path), driver: chosen.driver }
  } catch (cause) {
    throw new ToolkitError({
      code: 'CODEGRAPH_INDEX_UNREADABLE',
      message:
        `Could not open the index at "${path}" — it may not be a codegraph index or may be corrupt. ` +
        'Rebuild it with --force, or point --index at a different path.',
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
  private readonly db: SqlDb
  /** Which SQLite backend is in use. */
  readonly driver: SqliteDriver

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    const opened = openDb(dbPath)
    this.db = opened.db
    this.driver = opened.driver
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
    return { schemaVersion, treeSitterVersion, configHash, root: map.get('root') }
  }

  setMeta(meta: StoreMeta): void {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    const tx = this.db.transaction((m: StoreMeta) => {
      stmt.run('schemaVersion', String(m.schemaVersion))
      stmt.run('treeSitterVersion', m.treeSitterVersion)
      stmt.run('configHash', m.configHash)
      if (m.root !== undefined) stmt.run('root', m.root)
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

  commit(batch: GraphCommit): void {
    const putFile = this.db.prepare(
      'INSERT OR REPLACE INTO files (path, language, hash, facts_json) VALUES (?, ?, ?, ?)'
    )
    const delFile = this.db.prepare('DELETE FROM files WHERE path = ?')
    const insNode = this.db.prepare(
      `INSERT OR REPLACE INTO nodes (id, kind, name, symbol_kind, path, start_line, end_line, language)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const insEdge = this.db.prepare(
      'INSERT OR REPLACE INTO edges (from_id, to_id, kind, meta_json) VALUES (?, ?, ?, ?)'
    )
    const setMetaStmt = this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')

    const tx = this.db.transaction((b: GraphCommit) => {
      if (b.resetFiles) this.db.exec('DELETE FROM files;')
      else for (const p of b.deleteFiles ?? []) delFile.run(p)
      for (const r of b.facts) putFile.run(r.path, r.language, r.hash, JSON.stringify(r.facts))

      this.db.exec('DELETE FROM nodes; DELETE FROM edges;')
      for (const n of b.graph.nodes) {
        if (n.kind === 'symbol') {
          insNode.run(n.id, 'symbol', n.name, n.symbolKind, n.file, n.startLine, n.endLine, null)
        } else {
          insNode.run(n.id, 'file', null, null, n.path, null, null, n.language)
        }
      }
      for (const e of b.graph.edges) insEdge.run(e.from, e.to, e.kind, null)

      setMetaStmt.run('schemaVersion', String(b.meta.schemaVersion))
      setMetaStmt.run('treeSitterVersion', b.meta.treeSitterVersion)
      setMetaStmt.run('configHash', b.meta.configHash)
      if (b.meta.root !== undefined) setMetaStmt.run('root', b.meta.root)
    })
    tx(batch)
  }

  loadGraph(): SerializedCodeGraph | undefined {
    const nodeRows = this.db.prepare('SELECT * FROM nodes').all() as unknown as NodeRow[]
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

/**
 * Open a store, run `fn`, and always close it — the leak-safe way to use a store
 * for a one-off task without managing `close()` by hand.
 */
export async function withSqliteStore<T>(
  dbPath: string,
  fn: (store: SqliteGraphStore) => T | Promise<T>
): Promise<T> {
  const store = openSqliteStore(dbPath)
  try {
    return await fn(store)
  } finally {
    store.close()
  }
}
