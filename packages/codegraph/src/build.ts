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
import { CodeGraph, type EdgeMeta, type GraphEdge, type GraphNode, type SymbolNode } from './graph.js'
import {
  languageForExtension,
  parseFile,
  type DefinitionFact,
  type FileFacts,
  type ImportStyle,
  type LanguageSpec,
  type ReferenceFact,
  type TypeBinding
} from './parser.js'
import { STORE_SCHEMA_VERSION, type FileRecord, type FileStamp, type GraphStore, type StoreMeta } from './store.js'
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
  /**
   * Persist the resolved graph to the store (default true). Set false to update
   * only the parse-fact cache — `serve` uses this on hot rebuilds to avoid
   * rewriting the whole nodes/edges tables on every save, persisting the graph
   * once on shutdown instead. The graph is derived from facts, so a stale stored
   * graph is always safely rebuilt.
   */
  persistGraph?: boolean
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
  /** File size in bytes (from stat). */
  size: number
  /** Modification time in ms (from stat), used for cheap staleness checks. */
  mtimeMs: number
}

async function walk(options: BuildCodeGraphOptions): Promise<ScannedFile[]> {
  const ignore = new Set(
    options.replaceIgnore ? (options.ignore ?? []) : [...DEFAULT_IGNORE, ...(options.ignore ?? [])]
  )
  const languageFilter = options.languages ? new Set(options.languages) : undefined
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
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
        // stat here so oversize files are excluded from the scan set entirely —
        // they must not leak into fileSet (else they leave stale cache rows and
        // dangling import edges to a file node that is never created).
        const info = await stat(abs)
        if (info.size > maxBytes) continue
        files.push({
          relPath: toPosix(relative(options.dir, abs)),
          absPath: abs,
          spec,
          size: info.size,
          mtimeMs: info.mtimeMs
        })
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
  references: ReferenceFact[]
  imports: string[]
  typeBindings: TypeBinding[]
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

/** Innermost class/interface whose byte range contains `index`, or undefined. */
function enclosingClass(file: FileBuild, index: number): SymbolNode | undefined {
  let best: { node: SymbolNode; def: DefinitionFact } | undefined
  for (const entry of file.symbols) {
    if (
      (entry.node.symbolKind === 'class' || entry.node.symbolKind === 'interface') &&
      entry.def.startIndex <= index &&
      index <= entry.def.endIndex
    ) {
      if (!best || entry.def.startIndex > best.def.startIndex) best = entry
    }
  }
  return best?.node
}

// --- Call-graph resolution (confidence-scored, scope-aware) ----------------

const CONF_EXACT = 1.0
const CONF_HIGH = 0.8
const CONF_MEDIUM = 0.5
const JS_FAMILY_IDS = new Set(['javascript', 'typescript', 'tsx'])

/** Whether two language ids are close enough to resolve a call across (JS family counts as one). */
function sameFamily(a: string, b: string): boolean {
  return a === b || (JS_FAMILY_IDS.has(a) && JS_FAMILY_IDS.has(b))
}

interface Resolved {
  target: SymbolNode
  confidence: number
  receiverType?: string
}

/**
 * Resolve every call site to a definition with a confidence score and emit
 * `calls` edges. Precise where it can prove the target (local, `this`, imports,
 * `new X()`/typed receivers), conservative otherwise (skip rather than mis-wire).
 */
function resolveCallGraph(
  fileBuilds: FileBuild[],
  specByPath: Map<string, LanguageSpec>,
  definitionsByName: Map<string, SymbolNode[]>,
  addEdge: (edge: GraphEdge) => void
): void {
  const langOf = (relPath: string): string => specByPath.get(relPath)?.id ?? ''

  // Cross-file lookups: classes by name, methods by name, and per-class methods.
  const classByName = new Map<string, SymbolNode[]>()
  const methodByName = new Map<string, SymbolNode[]>()
  const methodsByClassId = new Map<string, Map<string, SymbolNode>>()

  for (const file of fileBuilds) {
    const classes = file.symbols.filter(
      (s) => s.node.symbolKind === 'class' || s.node.symbolKind === 'interface'
    )
    for (const c of classes) (classByName.get(c.node.name) ?? define(classByName, c.node.name)).push(c.node)
    for (const s of file.symbols) {
      if (s.node.symbolKind !== 'method' && s.node.symbolKind !== 'field') continue
      ;(methodByName.get(s.node.name) ?? define(methodByName, s.node.name)).push(s.node)
      const cls = classes.find(
        (c) => c.def.startIndex <= s.def.startIndex && s.def.endIndex <= c.def.endIndex
      )
      if (cls) {
        const m = methodsByClassId.get(cls.node.id) ?? new Map<string, SymbolNode>()
        if (!methodsByClassId.has(cls.node.id)) methodsByClassId.set(cls.node.id, m)
        if (!m.has(s.node.name)) m.set(s.node.name, s.node)
      }
    }
  }

  // Aggregate call sites so multiple A→B calls collapse to one edge with a count.
  const agg = new Map<string, GraphEdge & { meta: EdgeMeta }>()

  for (const file of fileBuilds) {
    const lang = file.spec.id
    const inFamily = (n: SymbolNode) => sameFamily(langOf(n.file), lang)

    const importedFiles = new Set<string>()
    for (const raw of file.imports) {
      const t = resolveImport(file.spec.importStyle, file.relPath, raw, new Set(specByPath.keys()))
      if (t) importedFiles.add(t)
    }

    // Local type env (var → class name); drop names bound to conflicting types.
    const typeEnv = new Map<string, string>()
    const conflicted = new Set<string>()
    for (const b of file.typeBindings) {
      if (conflicted.has(b.name)) continue
      const prev = typeEnv.get(b.name)
      if (prev && prev !== b.type) {
        typeEnv.delete(b.name)
        conflicted.add(b.name)
      } else typeEnv.set(b.name, b.type)
    }

    for (const ref of file.references) {
      const from = enclosingSymbol(file, ref.startIndex) ?? file.fileNode
      const resolved = resolveCall(ref, file, {
        inFamily,
        importedFiles,
        typeEnv,
        classByName,
        methodByName,
        methodsByClassId,
        definitionsByName,
        enclosingClassNode: enclosingClass(file, ref.startIndex)
      })
      if (!resolved || resolved.target.id === from.id) continue

      const key = `${from.id}->${resolved.target.id}`
      const prev = agg.get(key)
      if (prev) {
        prev.meta.confidence = Math.max(prev.meta.confidence ?? 0, resolved.confidence)
        prev.meta.callCount = (prev.meta.callCount ?? 1) + 1
        prev.meta.line = Math.min(prev.meta.line ?? ref.line, ref.line)
        if (ref.isNew) prev.meta.kind = 'new'
      } else {
        agg.set(key, {
          from: from.id,
          to: resolved.target.id,
          kind: 'calls',
          meta: {
            confidence: resolved.confidence,
            kind: ref.isNew ? 'new' : 'call',
            line: ref.line,
            callCount: 1,
            ...(resolved.receiverType ? { receiverType: resolved.receiverType } : {})
          }
        })
      }
    }
  }

  for (const edge of agg.values()) addEdge(edge)
}

interface ResolveCtx {
  inFamily: (n: SymbolNode) => boolean
  importedFiles: Set<string>
  typeEnv: Map<string, string>
  classByName: Map<string, SymbolNode[]>
  methodByName: Map<string, SymbolNode[]>
  methodsByClassId: Map<string, Map<string, SymbolNode>>
  definitionsByName: Map<string, SymbolNode[]>
  enclosingClassNode: SymbolNode | undefined
}

/** Resolve one call site to a target + confidence, or undefined if unprovable. */
function resolveCall(ref: ReferenceFact, file: FileBuild, ctx: ResolveCtx): Resolved | undefined {
  const method = (cls: SymbolNode | undefined, name: string): SymbolNode | undefined =>
    cls ? ctx.methodsByClassId.get(cls.id)?.get(name) : undefined

  // Constructor `new X()` → the class X.
  if (ref.isNew) {
    const target = pickUnique(ctx.classByName.get(ref.name), file, ctx)
    return target ? { target, confidence: CONF_HIGH } : undefined
  }

  if (ref.receiver) {
    // `this.m()` / `self.m()` → a method of the enclosing class.
    if (ref.receiver === 'this' || ref.receiver === 'self') {
      const m = method(ctx.enclosingClassNode, ref.name)
      return m ? { target: m, confidence: CONF_EXACT } : undefined
    }
    // `obj.m()` where obj's type is known (new X() / typed param).
    const typeName = ctx.typeEnv.get(ref.receiver)
    if (typeName) {
      const cls = pickUnique(ctx.classByName.get(typeName), file, ctx)
      const m = method(cls, ref.name)
      if (m) return { target: m, confidence: CONF_HIGH, receiverType: typeName }
    }
    // `Foo.m()` static call where the receiver is itself a class name.
    const staticCls = pickUnique(ctx.classByName.get(ref.receiver), file, ctx)
    const staticM = method(staticCls, ref.name)
    if (staticM) return { target: staticM, confidence: CONF_HIGH, receiverType: ref.receiver }
    // Unknown receiver: only if the method name is globally unique.
    const uniq = onlyInFamily(ctx.methodByName.get(ref.name), file, ctx)
    return uniq ? { target: uniq, confidence: CONF_MEDIUM } : undefined
  }

  // Bare call `foo()`: same-file, then imported-unique, then globally-unique.
  const cands = (ctx.definitionsByName.get(ref.name) ?? []).filter(ctx.inFamily)
  if (cands.length === 0) return undefined
  const sameFile = cands.find((c) => c.file === file.relPath)
  if (sameFile) return { target: sameFile, confidence: CONF_EXACT }
  const imported = cands.filter((c) => ctx.importedFiles.has(c.file))
  if (imported.length === 1) return { target: imported[0], confidence: CONF_HIGH }
  if (cands.length === 1) return { target: cands[0], confidence: CONF_HIGH }
  return undefined
}

/** The single family-matching candidate, or undefined if none/ambiguous. */
function pickUnique(
  cands: SymbolNode[] | undefined,
  file: FileBuild,
  ctx: ResolveCtx
): SymbolNode | undefined {
  const inFam = (cands ?? []).filter(ctx.inFamily)
  const sameFile = inFam.find((c) => c.file === file.relPath)
  if (sameFile) return sameFile
  return inFam.length === 1 ? inFam[0] : undefined
}

/** The single globally-unique family-matching candidate, or undefined. */
function onlyInFamily(
  cands: SymbolNode[] | undefined,
  _file: FileBuild,
  ctx: ResolveCtx
): SymbolNode | undefined {
  const inFam = (cands ?? []).filter(ctx.inFamily)
  return inFam.length === 1 ? inFam[0] : undefined
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

  const store = options.store
  const scanned = await walk(options)
  const fileSet = new Set(scanned.map((f) => f.relPath))

  // Inspect (read-only) the store's identity: a schema/grammar/config change
  // invalidates the whole cache, so we rebuild cold. Nothing is written until
  // the single atomic commit at the end, so a crash never half-writes the index.
  const wanted: StoreMeta = {
    schemaVersion: STORE_SCHEMA_VERSION,
    treeSitterVersion: treeSitterVersion(),
    configHash: configHash(options),
    root: resolve(options.dir)
  }
  const inspection = store ? await inspectStore(store, wanted) : undefined
  const compatible = inspection?.compatible ?? false
  const previousStamps = inspection?.previousStamps ?? new Map<string, FileStamp>()
  const cachedStamps = compatible ? previousStamps : new Map<string, FileStamp>()

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const definitionsByName = new Map<string, SymbolNode[]>()

  // Pass 1: decide reuse vs re-parse. Unchanged mtime+size ⇒ reuse cached facts
  // without even reading the file; otherwise read+hash and re-parse only when the
  // content hash actually changed (so a `touch` refreshes the stamp, not a parse).
  const specByPath = new Map<string, LanguageSpec>()
  const reusePaths: string[] = []
  const stampRefresh = new Map<string, { hash: string; language: string; mtimeMs: number; size: number }>()
  const factsByPath = new Map<string, FileFacts>()
  const toPut: FileRecord[] = []
  let parsed = 0

  for (const file of scanned) {
    options.signal?.throwIfAborted()
    specByPath.set(file.relPath, file.spec)
    const prev = cachedStamps.get(file.relPath)

    if (prev && prev.mtimeMs === file.mtimeMs && prev.size === file.size) {
      reusePaths.push(file.relPath) // unchanged — reuse without reading
      continue
    }

    const source = await readFile(file.absPath, 'utf8')
    const hash = hashSource(source)

    if (prev && prev.hash === hash) {
      // Same content, different mtime/size stamp — reuse facts, refresh the stamp.
      reusePaths.push(file.relPath)
      stampRefresh.set(file.relPath, { hash, language: file.spec.id, mtimeMs: file.mtimeMs, size: file.size })
      continue
    }

    const facts = await parseFile(file.spec, source)
    factsByPath.set(file.relPath, facts)
    if (store) {
      toPut.push({ path: file.relPath, language: file.spec.id, hash, mtimeMs: file.mtimeMs, size: file.size, facts })
    }
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
        const refresh = stampRefresh.get(relPath)
        if (refresh) {
          toPut.push({ path: relPath, language: refresh.language, hash: refresh.hash, mtimeMs: refresh.mtimeMs, size: refresh.size, facts: record.facts })
        }
      } else {
        // Stamp promised a cache hit but the facts row is gone — re-parse.
        const spec = specByPath.get(relPath)!
        const abs = join(options.dir, relPath)
        const [source, info] = await Promise.all([readFile(abs, 'utf8'), stat(abs)])
        const facts = await parseFile(spec, source)
        factsByPath.set(relPath, facts)
        toPut.push({ path: relPath, language: spec.id, hash: hashSource(source), mtimeMs: info.mtimeMs, size: info.size, facts })
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
      references: facts.references,
      imports: facts.imports.map((i) => i.raw),
      typeBindings: facts.typeBindings
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

  // Third pass: scope-aware, confidence-scored call graph ('calls' edges).
  resolveCallGraph(fileBuilds, specByPath, definitionsByName, addEdge)

  const graph = new CodeGraph(nodes, edges)

  let deleted = 0
  if (store) {
    // Warm build: drop files that vanished. Cold build: wipe the whole cache.
    const stale = compatible ? [...previousStamps.keys()].filter((p) => !fileSet.has(p)) : []
    deleted = stale.length
    await store.commit({
      facts: toPut,
      deleteFiles: stale,
      resetFiles: !compatible,
      graph: options.persistGraph === false ? undefined : graph.toJSON(),
      meta: wanted
    })
  }

  options.onStats?.({ files: fileBuilds.length, parsed, reused, deleted })
  return graph
}

/**
 * Rebuild a {@link CodeGraph} from a store's persisted graph without walking or
 * re-parsing the repo — the cheap "reopen an existing index" path. Returns
 * `undefined` if the store holds no graph yet.
 */
export async function loadCodeGraph(store: GraphStore): Promise<CodeGraph | undefined> {
  const data = await store.loadGraph()
  return data ? CodeGraph.fromJSON(data) : undefined
}

/**
 * Read-only check of whether the store matches the current
 * schema/grammar/config, plus its cached path→hash map. No writes happen here —
 * all persistence is deferred to a single atomic {@link GraphStore.commit}.
 */
async function inspectStore(
  store: GraphStore,
  wanted: StoreMeta
): Promise<{ compatible: boolean; previousStamps: Map<string, FileStamp> }> {
  const current = await store.meta()
  const compatible =
    current !== undefined &&
    current.schemaVersion === wanted.schemaVersion &&
    current.treeSitterVersion === wanted.treeSitterVersion &&
    current.configHash === wanted.configHash
  return { compatible, previousStamps: await store.getFileStamps() }
}

function define(map: Map<string, SymbolNode[]>, key: string): SymbolNode[] {
  const arr: SymbolNode[] = []
  map.set(key, arr)
  return arr
}
