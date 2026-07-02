/**
 * @ai-application-toolkit/codegraph
 *
 * Turn a folder of source code into a queryable, multi-language code graph
 * (files, symbols, imports, references) built with tree-sitter, with PageRank
 * context ranking for feeding the right code to an LLM.
 */
// Side-effect import: registers the PageRank implementation on CodeGraph.
import './rank.js'

export { buildCodeGraph, loadCodeGraph, type BuildCodeGraphOptions, type BuildStats } from './build.js'
export {
  STORE_SCHEMA_VERSION,
  type GraphStore,
  type StoreMeta,
  type FileRecord
} from './store.js'
export { SqliteGraphStore, openSqliteStore, withSqliteStore, type SqliteDriver } from './store.sqlite.js'
export { watchDirectory, type WatchOptions, type Watcher } from './watch.js'
export {
  CodeGraph,
  type EdgeKind,
  type FileNode,
  type GraphEdge,
  type GraphNode,
  type NeighborOptions,
  type RankedContextOptions,
  type RankedNode,
  type SerializedCodeGraph,
  type SymbolKind,
  type SymbolNode
} from './graph.js'
export { computePageRank } from './rank.js'
export {
  defineCodegraphCapability,
  type CodegraphCapabilityOptions
} from './tools.js'
export {
  languageForExtension,
  supportedExtensions,
  type LanguageSpec
} from './parser.js'
