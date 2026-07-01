import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildCodeGraph,
  CodeGraph,
  defineCodegraphCapability,
  languageForExtension,
  supportedExtensions
} from './index.js'

const SAMPLE_DIR = fileURLToPath(new URL('../fixtures/sample', import.meta.url))

describe('buildCodeGraph', () => {
  let graph: CodeGraph

  beforeAll(async () => {
    graph = await buildCodeGraph({ dir: SAMPLE_DIR })
  })

  it('indexes files across languages', () => {
    const paths = graph.files().map((f) => f.path).sort()
    expect(paths).toEqual(['App.java', 'Service.cs', 'app.py', 'lib.rs', 'main.ts', 'util.ts'])
  })

  it('finds symbol definitions with kind and location', () => {
    const [helper] = graph.findDefinition('helper')
    expect(helper).toMatchObject({ symbolKind: 'function', file: 'util.ts' })

    const [widget] = graph.findDefinition('Widget')
    expect(widget?.symbolKind).toBe('class')

    const [greeter] = graph.findDefinition('Greeter')
    expect(greeter?.symbolKind).toBe('class')
  })

  it('resolves relative imports into edges', () => {
    const summary = graph.fileSummary('main.ts')
    expect(summary?.imports.map((f) => f.path)).toContain('util.ts')
  })

  it('links references to their enclosing symbol', () => {
    // `run` (in main.ts) calls helper / new Widget / w.render
    const referrers = graph.findReferences('helper').map((n) => n.id)
    expect(referrers.some((id) => id.includes('run'))).toBe(true)

    // cross-file unique name resolves: run -> Widget.render
    const renderRefs = graph.findReferences('render').map((n) => n.id)
    expect(renderRefs.some((id) => id.includes('run'))).toBe(true)
  })

  it('resolves intra-file references in Python', () => {
    const greetRefs = graph.findReferences('greet').map((n) => n.id)
    expect(greetRefs.some((id) => id.includes('hello'))).toBe(true)
  })

  it('indexes C# classes, methods, and calls', () => {
    expect(graph.findDefinition('Service')[0]?.symbolKind).toBe('class')
    expect(graph.findDefinition('Compute')[0]?.symbolKind).toBe('method')
    // Compute() calls Helper() -> reference linked to enclosing method
    const helperRefs = graph.findReferences('Helper').map((n) => n.id)
    expect(helperRefs.some((id) => id.includes('Compute'))).toBe(true)
  })

  it('indexes Java classes, methods, and calls', () => {
    expect(graph.findDefinition('App')[0]?.symbolKind).toBe('class')
    expect(graph.findDefinition('execute')[0]?.symbolKind).toBe('method')
    const combineRefs = graph.findReferences('combine').map((n) => n.id)
    expect(combineRefs.some((id) => id.includes('execute'))).toBe(true)
  })

  it('indexes Rust functions and structs', () => {
    expect(graph.findDefinition('rust_main')[0]?.symbolKind).toBe('function')
    expect(graph.findDefinition('Gadget')[0]?.symbolKind).toBe('class')
    const helperRefs = graph.findReferences('rust_helper').map((n) => n.id)
    expect(helperRefs.some((id) => id.includes('rust_main'))).toBe(true)
  })

  it('ranks context, biased by seeds', () => {
    const ranked = graph.rankedContext({ seeds: ['helper'], limit: 5 })
    expect(ranked.length).toBeGreaterThan(0)
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[ranked.length - 1].score)
  })

  it('round-trips through JSON', () => {
    const restored = CodeGraph.fromJSON(graph.toJSON())
    expect(restored.files().length).toBe(graph.files().length)
    expect(restored.edges().length).toBe(graph.edges().length)
  })
})

describe('defineCodegraphCapability', () => {
  it('exposes query tools over the graph', async () => {
    const graph = await buildCodeGraph({ dir: SAMPLE_DIR })
    const capability = defineCodegraphCapability(graph)

    expect(capability.id).toBe('codegraph')
    const ids = capability.tools.map((t) => t.id)
    expect(ids).toContain('codegraph_relevant_context')
    expect(ids).toContain('codegraph_search_symbols')

    const search = capability.tools.find((t) => t.id === 'codegraph_search_symbols')
    const results = (await search!.execute({ name: 'help' })) as { name: string }[]
    expect(results.some((r) => r.name === 'helper')).toBe(true)

    const context = capability.tools.find((t) => t.id === 'codegraph_relevant_context')
    const ranked = (await context!.execute({ seeds: ['Greeter'], limit: 3 })) as unknown[]
    expect(ranked.length).toBeGreaterThan(0)
  })
})

describe('buildCodeGraph edge cases', () => {
  let tmpRoot: string

  beforeAll(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'codegraph-test-'))
  })

  afterAll(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  it('throws CODEGRAPH_DIR_NOT_FOUND for a nonexistent directory', async () => {
    await expect(
      buildCodeGraph({ dir: join(tmpRoot, 'does-not-exist') })
    ).rejects.toMatchObject({ code: 'CODEGRAPH_DIR_NOT_FOUND' })
  })

  it('throws CODEGRAPH_NOT_A_DIRECTORY when dir is a file', async () => {
    const filePath = join(tmpRoot, 'a-file.ts')
    await writeFile(filePath, 'export const x = 1\n')
    await expect(buildCodeGraph({ dir: filePath })).rejects.toMatchObject({
      code: 'CODEGRAPH_NOT_A_DIRECTORY'
    })
  })

  it('produces an empty graph for a directory with no supported files', async () => {
    const dir = join(tmpRoot, 'empty-lang')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'README.md'), '# nothing to parse\n')
    await writeFile(join(dir, 'data.json'), '{}\n')
    const graph = await buildCodeGraph({ dir })
    expect(graph.files()).toEqual([])
    expect(graph.symbols()).toEqual([])
    expect(graph.edges()).toEqual([])
  })

  it('filters by language id via the languages option', async () => {
    const dir = join(tmpRoot, 'mixed-lang')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'a.ts'), 'export function tsFn() { return 1 }\n')
    await writeFile(join(dir, 'b.py'), 'def py_fn():\n    return 1\n')
    const graph = await buildCodeGraph({ dir, languages: ['python'] })
    const langs = graph.files().map((f) => f.language)
    expect(langs).toEqual(['python'])
    expect(graph.findDefinition('tsFn')).toEqual([])
    expect(graph.findDefinition('py_fn').length).toBe(1)
  })

  it('recurses into subdirectories but honours the default ignore list', async () => {
    const dir = join(tmpRoot, 'nested')
    await mkdir(join(dir, 'sub'), { recursive: true })
    await mkdir(join(dir, 'node_modules'), { recursive: true })
    await writeFile(join(dir, 'sub', 'deep.ts'), 'export function deep() { return 1 }\n')
    await writeFile(join(dir, 'node_modules', 'ignored.ts'), 'export function ignored() {}\n')
    const graph = await buildCodeGraph({ dir })
    const paths = graph.files().map((f) => f.path)
    expect(paths).toContain('sub/deep.ts')
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false)
  })

  it('honours a custom ignore list merged with defaults', async () => {
    const dir = join(tmpRoot, 'custom-ignore')
    await mkdir(join(dir, 'generated'), { recursive: true })
    await writeFile(join(dir, 'kept.ts'), 'export function kept() { return 1 }\n')
    await writeFile(join(dir, 'generated', 'skip.ts'), 'export function skip() {}\n')
    const graph = await buildCodeGraph({ dir, ignore: ['generated'] })
    const paths = graph.files().map((f) => f.path)
    expect(paths).toEqual(['kept.ts'])
  })

  it('replaceIgnore lets otherwise-default-ignored dirs be scanned', async () => {
    const dir = join(tmpRoot, 'replace-ignore')
    await mkdir(join(dir, 'dist'), { recursive: true })
    await writeFile(join(dir, 'dist', 'built.ts'), 'export function built() { return 1 }\n')
    // With replaceIgnore + empty ignore, "dist" is no longer ignored.
    const graph = await buildCodeGraph({ dir, replaceIgnore: true, ignore: [] })
    const paths = graph.files().map((f) => f.path)
    expect(paths).toContain('dist/built.ts')
  })

  it('skips files larger than maxFileBytes', async () => {
    const dir = join(tmpRoot, 'big-file')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'big.ts'), 'export function big() { return 1 }\n')
    const graph = await buildCodeGraph({ dir, maxFileBytes: 5 })
    // File exists (a node created? no — skipped before node creation).
    expect(graph.findDefinition('big')).toEqual([])
    expect(graph.files()).toEqual([])
  })

  it('aborts when the provided signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      buildCodeGraph({ dir: SAMPLE_DIR, signal: controller.signal })
    ).rejects.toThrow()
  })

  it('resolves python relative imports across a package', async () => {
    const dir = join(tmpRoot, 'py-pkg')
    await mkdir(join(dir, 'pkg'), { recursive: true })
    await writeFile(join(dir, 'pkg', '__init__.py'), '')
    await writeFile(join(dir, 'pkg', 'core.py'), 'def core():\n    return 1\n')
    await writeFile(
      join(dir, 'pkg', 'main.py'),
      'from .core import core\n\ndef use():\n    return core()\n'
    )
    const graph = await buildCodeGraph({ dir })
    const summary = graph.fileSummary('pkg/main.py')
    expect(summary?.imports.map((f) => f.path)).toContain('pkg/core.py')
  })
})

describe('rankedContext ranking branches', () => {
  let graph: CodeGraph

  beforeAll(async () => {
    graph = await buildCodeGraph({ dir: SAMPLE_DIR })
  })

  it('ranks repo-wide when no seeds are given', () => {
    const ranked = graph.rankedContext()
    expect(ranked.length).toBeGreaterThan(0)
    // Default limit is 20.
    expect(ranked.length).toBeLessThanOrEqual(20)
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score)
    }
  })

  it('accepts a node id as a seed', () => {
    const [helper] = graph.findDefinition('helper')
    expect(helper).toBeDefined()
    const ranked = graph.rankedContext({ seeds: [helper!.id], limit: 3 })
    expect(ranked.length).toBeGreaterThan(0)
  })

  it('accepts a file path as a seed', () => {
    const ranked = graph.rankedContext({ seeds: ['main.ts'], limit: 3 })
    expect(ranked.length).toBeGreaterThan(0)
  })

  it('falls back to global ranking when seeds resolve to nothing', () => {
    const unknown = graph.rankedContext({ seeds: ['no-such-symbol-xyz'], limit: 5 })
    const global = graph.rankedContext({ limit: 5 })
    expect(unknown.map((r) => r.node.id)).toEqual(global.map((r) => r.node.id))
  })

  it('restricts results to a node kind', () => {
    const filesOnly = graph.rankedContext({ kind: 'file', limit: 50 })
    expect(filesOnly.length).toBeGreaterThan(0)
    expect(filesOnly.every((r) => r.node.kind === 'file')).toBe(true)

    const symbolsOnly = graph.rankedContext({ kind: 'symbol', limit: 50 })
    expect(symbolsOnly.every((r) => r.node.kind === 'symbol')).toBe(true)
  })

  it('respects an explicit limit and a zero limit', () => {
    expect(graph.rankedContext({ limit: 2 }).length).toBe(2)
    expect(graph.rankedContext({ limit: 0 })).toEqual([])
  })

  it('returns an empty ranking for an empty graph', () => {
    const empty = new CodeGraph([], [])
    expect(empty.rankedContext()).toEqual([])
  })
})

describe('CodeGraph query surface', () => {
  let graph: CodeGraph

  beforeAll(async () => {
    graph = await buildCodeGraph({ dir: SAMPLE_DIR })
  })

  it('returns no definitions for an unknown symbol name', () => {
    expect(graph.findDefinition('nonexistentSymbol')).toEqual([])
  })

  it('returns no references for an unknown symbol', () => {
    expect(graph.findReferences('nonexistentSymbol')).toEqual([])
  })

  it('returns undefined fileSummary for a missing file', () => {
    expect(graph.fileSummary('does/not/exist.ts')).toBeUndefined()
  })

  it('returns no neighbors for an unknown node id', () => {
    expect(graph.neighbors('file:missing.ts')).toEqual([])
  })

  it('getNode returns undefined for an unknown id', () => {
    expect(graph.getNode('sym:missing#x@1')).toBeUndefined()
  })

  it('exposes incoming and outgoing edges of a file node', () => {
    const [main] = graph.files().filter((f) => f.path === 'main.ts')
    expect(main).toBeDefined()
    const from = graph.edgesFrom(main!.id)
    expect(from.length).toBeGreaterThan(0)
    expect(from.every((e) => e.from === main!.id)).toBe(true)

    // util.ts is imported by main.ts, so it has an incoming imports edge.
    const [util] = graph.files().filter((f) => f.path === 'util.ts')
    const to = graph.edgesTo(util!.id)
    expect(to.some((e) => e.kind === 'imports')).toBe(true)
    expect(to.every((e) => e.to === util!.id)).toBe(true)
  })

  it('edgesFrom / edgesTo return empty arrays for unknown ids', () => {
    expect(graph.edgesFrom('file:unknown')).toEqual([])
    expect(graph.edgesTo('file:unknown')).toEqual([])
  })

  it('filters neighbors by direction and edge kind', () => {
    const [main] = graph.files().filter((f) => f.path === 'main.ts')
    const outImports = graph.neighbors(main!.id, {
      outgoing: true,
      incoming: false,
      edgeKinds: ['imports']
    })
    expect(outImports.some((n) => n.kind === 'file' && n.path === 'util.ts')).toBe(true)

    const onlyContains = graph.neighbors(main!.id, { edgeKinds: ['contains'] })
    expect(onlyContains.every((n) => n.kind === 'symbol')).toBe(true)
  })

  it('finds references by node id as well as by name', () => {
    const [helper] = graph.findDefinition('helper')
    const byName = graph.findReferences('helper').map((n) => n.id).sort()
    const byId = graph.findReferences(helper!.id).map((n) => n.id).sort()
    expect(byId).toEqual(byName)
  })

  it('round-trips an empty graph through JSON', () => {
    const empty = new CodeGraph([], [])
    const restored = CodeGraph.fromJSON(empty.toJSON())
    expect(restored.nodes()).toEqual([])
    expect(restored.edges()).toEqual([])
  })

  it('preserves query behaviour after a JSON round-trip', () => {
    const restored = CodeGraph.fromJSON(JSON.parse(JSON.stringify(graph.toJSON())))
    expect(restored.findDefinition('helper').length).toBe(graph.findDefinition('helper').length)
    expect(restored.findReferences('helper').map((n) => n.id).sort()).toEqual(
      graph.findReferences('helper').map((n) => n.id).sort()
    )
    expect(restored.rankedContext({ limit: 3 }).length).toBe(3)
  })
})

describe('parser language spec lookup', () => {
  it('maps known extensions to language specs (case-insensitive)', () => {
    expect(languageForExtension('.ts')?.id).toBe('typescript')
    expect(languageForExtension('.PY')?.id).toBe('python')
    expect(languageForExtension('.rs')?.id).toBe('rust')
  })

  it('returns undefined for an unsupported extension', () => {
    expect(languageForExtension('.txt')).toBeUndefined()
    expect(languageForExtension('')).toBeUndefined()
  })

  it('lists supported extensions including common ones', () => {
    const exts = supportedExtensions()
    expect(exts).toContain('.ts')
    expect(exts).toContain('.py')
    expect(exts).toContain('.java')
  })
})

describe('defineCodegraphCapability tool handlers', () => {
  let graph: CodeGraph
  let tools: Awaited<ReturnType<typeof defineCodegraphCapability>>['tools']

  beforeAll(async () => {
    graph = await buildCodeGraph({ dir: SAMPLE_DIR })
    tools = defineCodegraphCapability(graph).tools
  })

  const tool = (name: string) => tools.find((t) => t.id === `codegraph_${name}`)!

  it('honours a custom id prefix and default limit', async () => {
    const cap = defineCodegraphCapability(graph, { idPrefix: 'cg', defaultLimit: 1 })
    expect(cap.id).toBe('cg')
    const search = cap.tools.find((t) => t.id === 'cg_search_symbols')!
    const results = (await search.execute({})) as unknown[]
    expect(results.length).toBe(1)
  })

  it('search_symbols filters by kind and returns all when no name given', async () => {
    const results = (await tool('search_symbols').execute({ kind: 'class' })) as {
      kind: string
      symbolKind: string
    }[]
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => r.symbolKind === 'class')).toBe(true)
  })

  it('find_definition serializes an unknown symbol to an empty list', async () => {
    const results = (await tool('find_definition').execute({ name: 'no-such' })) as unknown[]
    expect(results).toEqual([])
  })

  it('find_references honours a limit', async () => {
    const all = (await tool('find_references').execute({ symbol: 'helper' })) as unknown[]
    const limited = (await tool('find_references').execute({
      symbol: 'helper',
      limit: 1
    })) as unknown[]
    expect(limited.length).toBeLessThanOrEqual(1)
    expect(limited.length).toBeLessThanOrEqual(all.length)
  })

  it('neighbors handler respects direction and edgeKinds and defaults', async () => {
    const [main] = graph.files().filter((f) => f.path === 'main.ts')
    const both = (await tool('neighbors').execute({ id: main!.id })) as unknown[]
    expect(both.length).toBeGreaterThan(0)

    const outOnly = (await tool('neighbors').execute({
      id: main!.id,
      direction: 'out',
      edgeKinds: ['imports'],
      limit: 5
    })) as { path?: string }[]
    expect(outOnly.some((n) => n.path === 'util.ts')).toBe(true)

    const inOnly = (await tool('neighbors').execute({
      id: main!.id,
      direction: 'in'
    })) as unknown[]
    expect(Array.isArray(inOnly)).toBe(true)
  })

  it('file_summary returns a serialized summary for a known file', async () => {
    const summary = (await tool('file_summary').execute({ path: 'main.ts' })) as {
      file: { kind: string; path: string }
      symbols: unknown[]
      imports: { path: string }[]
    } | null
    expect(summary).not.toBeNull()
    expect(summary!.file.path).toBe('main.ts')
    expect(summary!.imports.some((i) => i.path === 'util.ts')).toBe(true)
    expect(summary!.symbols.length).toBeGreaterThan(0)
  })

  it('file_summary returns null for a missing file', async () => {
    const summary = await tool('file_summary').execute({ path: 'nope.ts' })
    expect(summary).toBeNull()
  })

  it('relevant_context serializes ranked nodes with scores', async () => {
    const ranked = (await tool('relevant_context').execute({ limit: 3 })) as {
      node: { id: string }
      score: number
    }[]
    expect(ranked.length).toBe(3)
    expect(typeof ranked[0].score).toBe('number')
    expect(ranked[0].node.id).toBeDefined()
  })
})
