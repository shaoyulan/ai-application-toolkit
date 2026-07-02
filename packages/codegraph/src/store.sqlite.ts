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
import type { FileRecord, GraphStore, StoreMeta } from './store.js'

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

function openBetterSqlite(path: string): SqlDb {
  const Database = require('better-sqlite3') as new (p: string) => {
    exec(sql: string): unknown
    prepare(sql: string): SqlStatement
    transaction<T extends (...a: never[]) => unknown>(fn: T): T
    close(): void
  }
  const db = new Database(path)
  db.exec('PRAGMA journal_mode = WAL')
  return {
    exec: (sql) => void db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    transaction: (fn) => db.transaction(fn as never) as never,
    close: () => db.close()
  }
}

let warningSuppressed = false
/** Drop the noisy "SQLite is an experimental feature" warning once. */
function suppressSqliteExperimentalWarning(): void {
  if (warningSuppressed) return
  warningSuppressed = true
  const original = process.emitWarning.bind(process)
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const message = typeof warning === 'string' ? warning : (warning?.message ?? '')
    if (message.includes('SQLite is an experimental feature')) return
    return (original as (...a: unknown[]) => void)(warning, ...args)
  }) as typeof process.emitWarning
}

function openNodeSqlite(path: string): SqlDb {
  suppressSqliteExperimentalWarning()
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (p: string) => {
      exec(sql: string): unknown
      prepare(sql: string): SqlStatement
      close(): void
    }
  }
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  const exec = (sql: string) => void db.exec(sql)
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

/**
 * Open a SQLite database, preferring an installed better-sqlite3 over the
 * built-in node:sqlite. Set `CODEGRAPH_SQLITE_DRIVER=node` to force the built-in
 * (skip the native module) or `=better` to require better-sqlite3.
 */
function openDb(path: string): { db: SqlDb; driver: SqliteDriver } {
  const forced = process.env.CODEGRAPH_SQLITE_DRIVER
  if (forced !== 'node') {
    try {
      return { db: openBetterSqlite(path), driver: 'better-sqlite3' }
    } catch (cause) {
      if (forced === 'better') throw sqliteUnavailable(cause)
      // Not installed — fall through to the built-in driver.
    }
  }
  try {
    return { db: openNodeSqlite(path), driver: 'node:sqlite' }
  } catch (cause) {
    throw sqliteUnavailable(cause)
  }
}

function sqliteUnavailable(cause: unknown): ToolkitError {
  return new ToolkitError({
    code: 'CODEGRAPH_SQLITE_NOT_AVAILABLE',
    message:
      'Persistent indexing needs Node >= 23.4 (built-in node:sqlite) or the optional dependency "better-sqlite3" (npm i better-sqlite3).',
    cause
  })
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
