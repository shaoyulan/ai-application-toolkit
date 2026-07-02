/**
 * Exposes a {@link CodeGraph} as toolkit Tools, bundled into a Capability.
 *
 * Per AGENTS.md, anything an LLM/Runtime can invoke must be a Tool — so the
 * graph's query surface is wrapped here rather than handed to a model directly.
 * `codegraph_relevant_context` is the headline tool: it returns the ranked
 * neighbourhood of whatever the model is currently looking at.
 */
import { defineCapability, type Capability } from '@ai-application-toolkit/capability'
import { defineTool, type AnyToolDefinition } from '@ai-application-toolkit/tool'
import type { CodeGraph, EdgeKind, GraphNode, SymbolKind } from './graph.js'

export interface CodegraphCapabilityOptions {
  /** Prefix for tool ids. Default `codegraph`. */
  idPrefix?: string
  /** Default result cap for list-style tools. Default 25. */
  defaultLimit?: number
}

function serializeNode(node: GraphNode) {
  return node.kind === 'symbol'
    ? {
        id: node.id,
        kind: 'symbol' as const,
        name: node.name,
        symbolKind: node.symbolKind,
        file: node.file,
        startLine: node.startLine,
        endLine: node.endLine
      }
    : { id: node.id, kind: 'file' as const, path: node.path, language: node.language }
}

const EDGE_KINDS: EdgeKind[] = ['contains', 'imports', 'references', 'calls']

const TEST_FILE = /(\.test\.|\.spec\.|_test\.|_spec\.|\/tests?\/|\/__tests__\/)/i

function serializeImpactNode(item: import('./graph.js').ImpactNode) {
  const n = item.node
  const confidence = Math.round(item.confidence * 100) / 100
  return n.kind === 'symbol'
    ? { id: n.id, name: n.name, symbolKind: n.symbolKind, file: n.file, line: n.startLine, confidence }
    : { id: n.id, path: n.path, confidence }
}

export function defineCodegraphCapability(
  graph: CodeGraph | (() => CodeGraph),
  options: CodegraphCapabilityOptions = {}
): Capability {
  const prefix = options.idPrefix ?? 'codegraph'
  const defaultLimit = options.defaultLimit ?? 25
  const id = (name: string) => `${prefix}_${name}`
  // Resolve lazily so `serve --watch` can hot-swap the graph after an
  // incremental rebuild without recreating the capability.
  const getGraph = typeof graph === 'function' ? graph : () => graph

  const searchSymbols = defineTool<
    { name?: string; kind?: SymbolKind; limit?: number },
    ReturnType<typeof serializeNode>[]
  >({
    id: id('search_symbols'),
    description:
      'Search declared symbols by (case-insensitive substring) name and/or kind. Returns matching symbols with their file and line range.',
    input: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Substring to match against symbol names.' },
        kind: {
          type: 'string',
          description: 'Restrict to a symbol kind.',
          enum: ['function', 'method', 'class', 'interface', 'type', 'enum', 'field', 'variable']
        },
        limit: { type: 'integer', description: 'Maximum results.' }
      },
      additionalProperties: false
    },
    execute: ({ name, kind, limit }) => {
      const needle = name?.toLowerCase()
      const matches = getGraph()
        .symbols()
        .filter((s) => (needle ? s.name.toLowerCase().includes(needle) : true))
        .filter((s) => (kind ? s.symbolKind === kind : true))
        .slice(0, limit ?? defaultLimit)
      return matches.map(serializeNode)
    }
  })

  const findDefinition = defineTool<
    { name: string },
    ReturnType<typeof serializeNode>[]
  >({
    id: id('find_definition'),
    description: 'Find where a symbol is declared, by exact name.',
    input: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Exact symbol name.' } },
      required: ['name'],
      additionalProperties: false
    },
    execute: ({ name }) => getGraph().findDefinition(name).map(serializeNode)
  })

  const findReferences = defineTool<
    { symbol: string; limit?: number },
    ReturnType<typeof serializeNode>[]
  >({
    id: id('find_references'),
    description: 'Find the files and symbols that reference a given symbol (by id or name).',
    input: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol node id or bare name.' },
        limit: { type: 'integer', description: 'Maximum results.' }
      },
      required: ['symbol'],
      additionalProperties: false
    },
    execute: ({ symbol, limit }) =>
      getGraph().findReferences(symbol).slice(0, limit ?? defaultLimit).map(serializeNode)
  })

  const neighbors = defineTool<
    { id: string; direction?: 'in' | 'out' | 'both'; edgeKinds?: EdgeKind[]; limit?: number },
    ReturnType<typeof serializeNode>[]
  >({
    id: id('neighbors'),
    description: 'List nodes directly connected to a node, optionally filtered by edge kind/direction.',
    input: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Node id (file:… or sym:…).' },
        direction: { type: 'string', enum: ['in', 'out', 'both'] },
        edgeKinds: {
          type: 'array',
          items: { type: 'string', enum: EDGE_KINDS },
          description: 'Restrict to these edge kinds.'
        },
        limit: { type: 'integer' }
      },
      required: ['id'],
      additionalProperties: false
    },
    execute: ({ id: nodeId, direction = 'both', edgeKinds, limit }) =>
      getGraph()
        .neighbors(nodeId, {
          outgoing: direction !== 'in',
          incoming: direction !== 'out',
          edgeKinds
        })
        .slice(0, limit ?? defaultLimit)
        .map(serializeNode)
  })

  const fileSummary = defineTool<
    { path: string },
    {
      file: ReturnType<typeof serializeNode>
      symbols: ReturnType<typeof serializeNode>[]
      imports: ReturnType<typeof serializeNode>[]
    } | null
  >({
    id: id('file_summary'),
    description: 'Summarize one file: the symbols it declares and the files it imports.',
    input: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Repo-relative file path.' } },
      required: ['path'],
      additionalProperties: false
    },
    execute: ({ path }) => {
      const summary = getGraph().fileSummary(path)
      if (!summary) return null
      return {
        file: serializeNode(summary.file),
        symbols: summary.symbols.map(serializeNode),
        imports: summary.imports.map(serializeNode)
      }
    }
  })

  const relevantContext = defineTool<
    { seeds?: string[]; kind?: GraphNode['kind']; limit?: number },
    { node: ReturnType<typeof serializeNode>; score: number }[]
  >({
    id: id('relevant_context'),
    description:
      'Rank the most relevant files/symbols using PageRank over the code graph. Pass `seeds` (symbol names, ids, or file paths) to focus on what you are working on; omit for repo-wide importance.',
    input: {
      type: 'object',
      properties: {
        seeds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Symbol names, node ids, or file paths to bias ranking towards.'
        },
        kind: { type: 'string', enum: ['file', 'symbol'] },
        limit: { type: 'integer' }
      },
      additionalProperties: false
    },
    execute: ({ seeds, kind, limit }) =>
      getGraph()
        .rankedContext({ seeds, kind, limit: limit ?? defaultLimit })
        .map((r) => ({ node: serializeNode(r.node), score: r.score }))
  })

  const callers = defineTool<
    { symbol: string; minConfidence?: number; limit?: number },
    ReturnType<typeof serializeImpactNode>[]
  >({
    id: id('callers'),
    description:
      'Direct callers of a symbol (who calls it), each with a confidence score. Use before changing a symbol.',
    input: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol node id or exact name.' },
        minConfidence: { type: 'number', description: 'Drop edges below this confidence (0–1).' },
        limit: { type: 'integer' }
      },
      required: ['symbol'],
      additionalProperties: false
    },
    execute: ({ symbol, minConfidence, limit }) =>
      (getGraph().impact(symbol, { direction: 'callers', maxDepth: 1, minConfidence }).groups[0]?.nodes ?? [])
        .slice(0, limit ?? defaultLimit)
        .map(serializeImpactNode)
  })

  const callees = defineTool<
    { symbol: string; minConfidence?: number; limit?: number },
    ReturnType<typeof serializeImpactNode>[]
  >({
    id: id('callees'),
    description: 'Direct callees of a symbol (what it calls), each with a confidence score.',
    input: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol node id or exact name.' },
        minConfidence: { type: 'number', description: 'Drop edges below this confidence (0–1).' },
        limit: { type: 'integer' }
      },
      required: ['symbol'],
      additionalProperties: false
    },
    execute: ({ symbol, minConfidence, limit }) =>
      (getGraph().impact(symbol, { direction: 'callees', maxDepth: 1, minConfidence }).groups[0]?.nodes ?? [])
        .slice(0, limit ?? defaultLimit)
        .map(serializeImpactNode)
  })

  const impact = defineTool<
    { symbol: string; maxDepth?: number; minConfidence?: number },
    {
      target: string
      groups: { depth: number; nodes: ReturnType<typeof serializeImpactNode>[] }[]
      truncated: boolean
    }
  >({
    id: id('impact'),
    description:
      'Blast radius of changing a symbol: every transitive caller grouped by depth, each with a confidence score. One call replaces chaining many caller lookups.',
    input: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol node id or exact name.' },
        maxDepth: { type: 'integer', description: 'Max hops (default 5).' },
        minConfidence: { type: 'number', description: 'Drop edges below this confidence (0–1).' }
      },
      required: ['symbol'],
      additionalProperties: false
    },
    execute: ({ symbol, maxDepth, minConfidence }) => {
      const result = getGraph().impact(symbol, { direction: 'callers', maxDepth, minConfidence })
      return {
        target: symbol,
        groups: result.groups.map((g) => ({ depth: g.depth, nodes: g.nodes.map(serializeImpactNode) })),
        truncated: result.truncated
      }
    }
  })

  const affected = defineTool<
    { symbol: string; maxDepth?: number; minConfidence?: number },
    ReturnType<typeof serializeImpactNode>[]
  >({
    id: id('affected'),
    description:
      'Test files/symbols in the blast radius of a symbol — which tests to run after changing it.',
    input: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol node id or exact name.' },
        maxDepth: { type: 'integer', description: 'Max hops (default 5).' },
        minConfidence: { type: 'number', description: 'Drop edges below this confidence (0–1).' }
      },
      required: ['symbol'],
      additionalProperties: false
    },
    execute: ({ symbol, maxDepth, minConfidence }) =>
      getGraph()
        .impact(symbol, { direction: 'callers', maxDepth, minConfidence })
        .groups.flatMap((g) => g.nodes)
        .filter((item) => TEST_FILE.test(item.node.kind === 'symbol' ? item.node.file : item.node.path))
        .map(serializeImpactNode)
  })

  const tools: AnyToolDefinition[] = [
    searchSymbols,
    findDefinition,
    findReferences,
    neighbors,
    fileSummary,
    relevantContext,
    callers,
    callees,
    impact,
    affected
  ]

  return defineCapability({
    id: prefix,
    description: 'Query a multi-language code graph: symbols, references, imports, and ranked context.',
    tools
  })
}
