/**
 * `buildCodeGraph` — walk a folder, parse every supported source file, and
 * assemble a {@link CodeGraph} of files, symbols, imports and references.
 *
 * Import and reference resolution is best-effort and name-based: it links what
 * it can prove within the scanned set and skips ambiguous cases rather than
 * inventing edges. This keeps the graph high-precision, which matters most when
 * it is used to select context for an LLM.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join, posix, relative, resolve, sep } from 'node:path'
import { ToolkitError } from '@ai-application-toolkit/core'
import { CodeGraph, type GraphEdge, type GraphNode, type SymbolNode } from './graph.js'
import {
  languageForExtension,
  parseFile,
  type DefinitionFact,
  type FileFacts,
  type ImportStyle,
  type LanguageSpec
} from './parser.js'
import { STORE_SCHEMA_VERSION, type FileRecord, type GraphStore, type StoreMeta } from './store.js'
// Importing rank.ts here guarantees the PageRank implementation is registered
// before any CodeGraph this module returns is used.
import './rank.js'

const require = createRequire(import.meta.url)

/** Content hash used as the incremental-build cache key. */
function hashSource(source: string): string {
  return createHash('sha1').update(source).digest('hex')
}

/** Installed version of a package, resilient to `exports` blocking deep imports. */
function packageVersion(pkg: string): string {
  try {
    let dir = dirname(require.resolve(pkg))
    for (let i = 0; i < 8; i++) {
      const candidate = join(dir, 'package.json')
      if (existsSync(candidate)) {
        const json = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string }
        if (json.name === pkg) return json.version ?? '0'
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // Fall through to the sentinel below.
  }
  return '0'
}

/** Parser + grammar versions, so a bump invalidates the incremental cache. */
function treeSitterVersion(): string {
  return `${packageVersion('web-tree-sitter')}+${packageVersion('@vscode/tree-sitter-wasm')}`
}

/** Hash of the inputs that change what gets parsed, beyond file contents. */
function configHash(options: BuildCodeGraphOptions): string {
  const langs = options.languages ? [...options.languages].sort() : null
  return createHash('sha1')
    .update(JSON.stringify({ langs, maxFileBytes: options.maxFileBytes ?? null }))
    .digest('hex')
}

export interface BuildCodeGraphOptions {
  /** Root folder to scan. */
  dir: string
  /** Restrict to these language ids (e.g. `['typescript', 'python']`). */
  languages?: string[]
  /**
   * Directory and file names to skip. Merged with sensible defaults
   * (node_modules, .git, dist, build, …) unless `replaceIgnore` is set.
   */
  ignore?: string[]
  /** Replace the default ignore list instead of extending it. */
  replaceIgnore?: boolean
  /** Skip files larger than this many bytes. Default 1.5 MB. */
  maxFileBytes?: number
  /**
   * Persist parse results and the resolved graph here. When set, unchanged files
   * (same content hash) are loaded from the store instead of re-parsed. Omit for
   * a pure in-memory build (the default).
   */
  store?: GraphStore
  /** Called once with build counts (files parsed vs reused) after a build. */
  onStats?: (stats: BuildStats) => void
  signal?: AbortSignal
}

/** Per-build counts, reported via {@link BuildCodeGraphOptions.onStats}. */
export interface BuildStats {
  /** Files considered (recognized extension, within size limit). */
  files: number
  /** Files parsed this build. */
  parsed: number
  /** Files served from the store cache without re-parsing. */
  reused: number
  /** Cached files removed because they no longer exist on disk. */
  deleted: number
}

const DEFAULT_IGNORE = [
  'node_modules',
  '.git',
  '.codegraph',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  'vendor',
  '__pycache__'
]

const DEFAULT_MAX_FILE_BYTES = 1_500_000

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/')
}

interface ScannedFile {
  relPath: string
  absPath: string
  spec: LanguageSpec
}

async function walk(options: BuildCodeGraphOptions): Promise<ScannedFile[]> {
  const ignore = new Set(
    options.replaceIgnore ? (options.ignore ?? []) : [...DEFAULT_IGNORE, ...(options.ignore ?? [])]
  )
  const languageFilter = options.languages ? new Set(options.languages) : undefined
  const files: ScannedFile[] = []

  async function recurse(absDir: string): Promise<void> {
    options.signal?.throwIfAborted()
    const entries = await readdir(absDir, { withFileTypes: true })
    for (const entry of entries) {
      if (ignore.has(entry.name)) continue
      const abs = join(absDir, entry.name)
      if (entry.isDirectory()) {
        await recurse(abs)
      } else if (entry.isFile()) {
        const spec = languageForExtension(extname(entry.name))
        if (!spec) continue
        if (languageFilter && !languageFilter.has(spec.id)) continue
        files.push({ relPath: toPosix(relative(options.dir, abs)), absPath: abs, spec })
      }
    }
  }

  await recurse(options.dir)
  return files
}

const fileNodeId = (relPath: string): string => `file:${relPath}`
const symbolNodeId = (relPath: string, name: string, line: number): string =>
  `sym:${relPath}#${name}@${line}`

interface FileBuild {
  relPath: string
  spec: LanguageSpec
  fileNode: GraphNode
  symbols: { node: SymbolNode; def: DefinitionFact }[]
  references: { name: string; startIndex: number }[]
  imports: string[]
}

/** Innermost symbol whose byte range contains `index`, or undefined. */
function enclosingSymbol(file: FileBuild, index: number): SymbolNode | undefined {
  let best: { node: SymbolNode; def: DefinitionFact } | undefined
  for (const entry of file.symbols) {
    if (entry.def.startIndex <= index && index <= entry.def.endIndex) {
      if (!best || entry.def.startIndex > best.def.startIndex) best = entry
    }
  }
  return best?.node
}

/** Resolve a relative ESM/CJS specifier to a scanned file's relPath. */
function resolveEsmImport(
  fromRelPath: string,
  spec: string,
  fileSet: Set<string>
): string | undefined {
  if (!spec.startsWith('.')) return undefined // bare specifier — external package
  const base = posix.normalize(posix.join(posix.dirname(fromRelPath), spec))
  const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']
  const candidates = [
    base,
    ...exts.map((e) => base + e),
    ...exts.map((e) => posix.join(base, 'index' + e))
  ]
  return candidates.find((c) => fileSet.has(c))
}

/** Resolve a Python import specifier to a scanned file's relPath. */
function resolvePythonImport(
  fromRelPath: string,
  spec: string,
  fileSet: Set<string>
): string | undefined {
  let modulePath: string
  const leadingDots = spec.match(/^\.+/)?.[0].length ?? 0
  if (leadingDots > 0) {
    // Relative import: each dot climbs one package level from the file's dir.
    let dir = posix.dirname(fromRelPath)
    for (let i = 1; i < leadingDots; i++) dir = posix.dirname(dir)
    const rest = spec.slice(leadingDots).replace(/\./g, '/')
    modulePath = rest ? posix.join(dir, rest) : dir
  } else {
    modulePath = spec.replace(/\./g, '/')
  }
  const candidates = [modulePath + '.py', posix.join(modulePath, '__init__.py')]
  return candidates.find((c) => fileSet.has(c))
}

function resolveImport(
  style: ImportStyle,
  fromRelPath: string,
  spec: string,
  fileSet: Set<string>
): string | undefined {
  switch (style) {
    case 'esm-relative':
      return resolveEsmImport(fromRelPath, spec, fileSet)
    case 'python':
      return resolvePythonImport(fromRelPath, spec, fileSet)
    case 'none':
      return undefined
  }
}

export async function buildCodeGraph(options: BuildCodeGraphOptions): Promise<CodeGraph> {
  let rootStat
  try {
    rootStat = await stat(options.dir)
  } catch (cause) {
    throw new ToolkitError({
      code: 'CODEGRAPH_DIR_NOT_FOUND',
      message: `Cannot scan "${options.dir}"`,
      cause
    })
  }
  if (!rootStat.isDirectory()) {
    throw new ToolkitError({
      code: 'CODEGRAPH_NOT_A_DIRECTORY',
      message: `"${options.dir}" is not a directory`
    })
  }

  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const store = options.store
  const scanned = await walk(options)
  const fileSet = new Set(scanned.map((f) => f.relPath))

  // Reconcile the store's identity: a schema/grammar/config change invalidates
  // the whole cache, so drop it and rebuild cold.
  const cachedHashes = store ? await reconcileStore(store, options) : new Map<string, string>()

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const definitionsByName = new Map<string, SymbolNode[]>()

  // Pass 1: read + hash each file, deciding reuse vs re-parse.
  const specByPath = new Map<string, LanguageSpec>()
  const reusePaths: string[] = []
  const factsByPath = new Map<string, FileFacts>()
  const toPut: FileRecord[] = []
  let parsed = 0

  for (const file of scanned) {
    options.signal?.throwIfAborted()
    const source = await readFile(file.absPath, 'utf8')
    if (Buffer.byteLength(source) > maxBytes) continue
    specByPath.set(file.relPath, file.spec)
    const hash = hashSource(source)

    if (store && cachedHashes.get(file.relPath) === hash) {
      reusePaths.push(file.relPath)
      continue
    }

    const facts = await parseFile(file.spec, source)
    factsByPath.set(file.relPath, facts)
    if (store) toPut.push({ path: file.relPath, language: file.spec.id, hash, facts })
    parsed++
  }

  // Load reused facts from the store in one batch; re-parse on a cache miss.
  let reused = 0
  if (store && reusePaths.length > 0) {
    const records = await store.getFacts(reusePaths)
    for (const relPath of reusePaths) {
      const record = records.get(relPath)
      if (record) {
        factsByPath.set(relPath, record.facts)
        reused++
      } else {
        const spec = specByPath.get(relPath)!
        const source = await readFile(join(options.dir, relPath), 'utf8')
        const facts = await parseFile(spec, source)
        factsByPath.set(relPath, facts)
        toPut.push({ path: relPath, language: spec.id, hash: hashSource(source), facts })
        parsed++
      }
    }
  }

  // Build file/symbol nodes + contains edges from the assembled facts.
  const fileBuilds: FileBuild[] = []
  for (const relPath of specByPath.keys()) {
    const facts = factsByPath.get(relPath)
    if (!facts) continue
    const spec = specByPath.get(relPath)!
    const fileNode: GraphNode = {
      id: fileNodeId(relPath),
      kind: 'file',
      path: relPath,
      language: spec.id
    }
    nodes.push(fileNode)

    const build: FileBuild = {
      relPath,
      spec,
      fileNode,
      symbols: [],
      references: facts.references.map((r) => ({ name: r.name, startIndex: r.startIndex })),
      imports: facts.imports.map((i) => i.raw)
    }

    for (const def of facts.definitions) {
      const node: SymbolNode = {
        id: symbolNodeId(relPath, def.name, def.startLine),
        kind: 'symbol',
        name: def.name,
        symbolKind: def.kind,
        file: relPath,
        startLine: def.startLine,
        endLine: def.endLine
      }
      nodes.push(node)
      edges.push({ from: fileNode.id, to: node.id, kind: 'contains' })
      build.symbols.push({ node, def })
      ;(definitionsByName.get(def.name) ?? define(definitionsByName, def.name)).push(node)
    }

    fileBuilds.push(build)
  }

  // Second pass: imports and references (need the full file/symbol set).
  const seenEdges = new Set<string>(edges.map((e) => `${e.kind}:${e.from}->${e.to}`))
  const addEdge = (edge: GraphEdge) => {
    if (edge.from === edge.to) return
    const key = `${edge.kind}:${edge.from}->${edge.to}`
    if (seenEdges.has(key)) return
    seenEdges.add(key)
    edges.push(edge)
  }

  for (const file of fileBuilds) {
    for (const raw of file.imports) {
      const target = resolveImport(file.spec.importStyle, file.relPath, raw, fileSet)
      if (target) addEdge({ from: file.fileNode.id, to: fileNodeId(target), kind: 'imports' })
    }

    for (const ref of file.references) {
      const candidates = definitionsByName.get(ref.name)
      if (!candidates || candidates.length === 0) continue

      const target =
        candidates.find((c) => c.file === file.relPath) ??
        (candidates.length === 1 ? candidates[0] : undefined)
      if (!target) continue // ambiguous cross-file name — skip rather than guess

      const fromNode = enclosingSymbol(file, ref.startIndex) ?? file.fileNode
      addEdge({ from: fromNode.id, to: target.id, kind: 'references' })
    }
  }

  const graph = new CodeGraph(nodes, edges)

  let deleted = 0
  if (store) {
    if (toPut.length > 0) await store.putFacts(toPut)
    const stale = [...cachedHashes.keys()].filter((p) => !fileSet.has(p))
    if (stale.length > 0) {
      await store.deleteFiles(stale)
      deleted = stale.length
    }
    await store.saveGraph(graph.toJSON())
  }

  options.onStats?.({ files: fileBuilds.length, parsed, reused, deleted })
  return graph
}

/**
 * Ensure the store matches the current schema/grammar/config; if not, wipe its
 * cache and re-stamp its identity. Returns the (possibly empty) path→hash map to
 * compare files against.
 */
async function reconcileStore(
  store: GraphStore,
  options: BuildCodeGraphOptions
): Promise<Map<string, string>> {
  const wanted: StoreMeta = {
    schemaVersion: STORE_SCHEMA_VERSION,
    treeSitterVersion: treeSitterVersion(),
    configHash: configHash(options),
    root: resolve(options.dir)
  }
  const current = await store.meta()
  const compatible =
    current !== undefined &&
    current.schemaVersion === wanted.schemaVersion &&
    current.treeSitterVersion === wanted.treeSitterVersion &&
    current.configHash === wanted.configHash

  if (compatible) {
    // Keep the recorded repo path current if the index moved or is reused.
    if (current.root !== wanted.root) await store.setMeta(wanted)
    return store.getFileHashes()
  }

  const previous = await store.getFileHashes()
  if (previous.size > 0) await store.deleteFiles([...previous.keys()])
  await store.setMeta(wanted)
  return new Map()
}

function define(map: Map<string, SymbolNode[]>, key: string): SymbolNode[] {
  const arr: SymbolNode[] = []
  map.set(key, arr)
  return arr
}
