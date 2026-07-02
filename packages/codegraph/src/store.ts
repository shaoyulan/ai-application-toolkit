/**
 * Persistence seam for the code graph.
 *
 * `buildCodeGraph` can run purely in memory (the default, unchanged for library
 * callers) or against a {@link GraphStore}, which caches per-file parse results
 * keyed by content hash so unchanged files are never re-parsed, and persists the
 * resolved graph so `serve` can start without a cold build.
 *
 * The interface is intentionally small and synchronous-friendly: the only
 * shipped implementation ({@link SqliteGraphStore}) is a local embedded DB, but
 * keeping build/serve behind this seam means an alternative backend can drop in
 * without touching the build pipeline.
 */
import type { Awaitable } from '@ai-application-toolkit/core'
import type { SerializedCodeGraph } from './graph.js'
import type { FileFacts } from './parser.js'

/** Bumped when the on-disk schema or fact shape changes incompatibly. */
export const STORE_SCHEMA_VERSION = 1

/** Identifies the index build so a mismatch forces a cold rebuild. */
export interface StoreMeta {
  /** {@link STORE_SCHEMA_VERSION} the DB was written with. */
  schemaVersion: number
  /** Version of `web-tree-sitter` the facts were parsed with. */
  treeSitterVersion: string
  /** Hash of the build configuration (e.g. the language filter). */
  configHash: string
  /** Absolute path of the indexed repo, so an index can name its project. */
  root?: string
}

/** A file's cached parse result, keyed by its content hash. */
export interface FileRecord {
  /** Repo-relative POSIX path. */
  path: string
  /** Language id (e.g. `typescript`). */
  language: string
  /** Content hash of the file the facts were parsed from. */
  hash: string
  /** The extracted parse facts. */
  facts: FileFacts
}

/** A completed build to persist atomically via {@link GraphStore.commit}. */
export interface GraphCommit {
  /** Parse facts to insert or replace. */
  facts: FileRecord[]
  /** Cached files to drop (stale/deleted). Ignored when `resetFiles` is set. */
  deleteFiles?: string[]
  /** Clear the whole file cache first (used for a cold rebuild). */
  resetFiles?: boolean
  /** The resolved graph to persist (replaces any previous graph). */
  graph: SerializedCodeGraph
  /** Index identity to stamp. */
  meta: StoreMeta
}

/**
 * A cache of per-file parse facts plus the resolved graph. Implementations may
 * be sync or async; callers `await` every method so either works.
 */
export interface GraphStore {
  /** Current index identity, or undefined if the store has never been written. */
  meta(): Awaitable<StoreMeta | undefined>
  /** Record the index identity (called once per build). */
  setMeta(meta: StoreMeta): Awaitable<void>

  /** Map of cached path -> content hash, for fast staleness comparison. */
  getFileHashes(): Awaitable<Map<string, string>>
  /** Cached parse facts for the given paths (missing paths are omitted). */
  getFacts(paths: string[]): Awaitable<Map<string, FileRecord>>
  /** Insert or replace cached parse facts. */
  putFacts(records: FileRecord[]): Awaitable<void>
  /** Drop cached facts for files that no longer exist. */
  deleteFiles(paths: string[]): Awaitable<void>

  /** Persist the resolved graph (replaces any previously stored graph). */
  saveGraph(graph: SerializedCodeGraph): Awaitable<void>
  /** Load the persisted graph, or undefined if none has been saved. */
  loadGraph(): Awaitable<SerializedCodeGraph | undefined>

  /**
   * Atomically persist a whole build — facts, deletions, resolved graph, and
   * meta — in a single transaction, so a crash leaves the index either fully
   * updated or untouched (never half-written).
   */
  commit(batch: GraphCommit): Awaitable<void>

  /** Release any underlying resources (file handles, DB connection). */
  close(): Awaitable<void>
}
