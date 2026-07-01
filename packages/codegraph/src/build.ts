/**
 * `buildCodeGraph` — walk a folder, parse every supported source file, and
 * assemble a {@link CodeGraph} of files, symbols, imports and references.
 *
 * Import and reference resolution is best-effort and name-based: it links what
 * it can prove within the scanned set and skips ambiguous cases rather than
 * inventing edges. This keeps the graph high-precision, which matters most when
 * it is used to select context for an LLM.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, posix, relative, sep } from 'node:path'
import { ToolkitError } from '@ai-application-toolkit/core'
import { CodeGraph, type GraphEdge, type GraphNode, type SymbolNode } from './graph.js'
import {
  languageForExtension,
  parseFile,
  type DefinitionFact,
  type ImportStyle,
  type LanguageSpec
} from './parser.js'
// Importing rank.ts here guarantees the PageRank implementation is registered
// before any CodeGraph this module returns is used.
import './rank.js'

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
  signal?: AbortSignal
}

const DEFAULT_IGNORE = [
  'node_modules',
  '.git',
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
  const scanned = await walk(options)
  const fileSet = new Set(scanned.map((f) => f.relPath))

  const fileBuilds: FileBuild[] = []
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const definitionsByName = new Map<string, SymbolNode[]>()

  for (const file of scanned) {
    options.signal?.throwIfAborted()
    const source = await readFile(file.absPath, 'utf8')
    if (Buffer.byteLength(source) > maxBytes) continue

    const facts = await parseFile(file.spec, source)
    const fileNode: GraphNode = {
      id: fileNodeId(file.relPath),
      kind: 'file',
      path: file.relPath,
      language: file.spec.id
    }
    nodes.push(fileNode)

    const build: FileBuild = {
      relPath: file.relPath,
      spec: file.spec,
      fileNode,
      symbols: [],
      references: facts.references.map((r) => ({ name: r.name, startIndex: r.startIndex })),
      imports: facts.imports.map((i) => i.raw)
    }

    for (const def of facts.definitions) {
      const node: SymbolNode = {
        id: symbolNodeId(file.relPath, def.name, def.startLine),
        kind: 'symbol',
        name: def.name,
        symbolKind: def.kind,
        file: file.relPath,
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

  return new CodeGraph(nodes, edges)
}

function define(map: Map<string, SymbolNode[]>, key: string): SymbolNode[] {
  const arr: SymbolNode[] = []
  map.set(key, arr)
  return arr
}
