import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildCodeGraph, CodeGraph, defineCodegraphCapability } from './index.js'

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
