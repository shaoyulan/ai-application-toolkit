/**
 * PageRank over the code graph — the bridge from "static graph" to "LLM
 * context". Importance flows along `imports`/`references`/`contains` edges, so
 * a symbol that many others call ranks highly. Passing `seeds` switches to
 * personalized PageRank, biasing importance towards the neighbourhood of the
 * symbols you already care about (the repo-map ranking trick).
 */
import {
  _registerRanker,
  CodeGraph,
  type GraphNode,
  type RankedContextOptions,
  type RankedNode
} from './graph.js'

const DAMPING = 0.85
const MAX_ITERATIONS = 50
const TOLERANCE = 1e-6

/** Resolve user-supplied seeds (node ids, symbol names, or file paths) to ids. */
function resolveSeeds(graph: CodeGraph, seeds: string[]): Set<string> {
  const ids = new Set<string>()
  for (const seed of seeds) {
    if (graph.getNode(seed)) {
      ids.add(seed)
      continue
    }
    for (const symbol of graph.findDefinition(seed)) ids.add(symbol.id)
    for (const file of graph.files()) {
      if (file.path === seed) ids.add(file.id)
    }
  }
  return ids
}

function computePageRank(graph: CodeGraph, options: RankedContextOptions = {}): RankedNode[] {
  const nodes = graph.nodes()
  const n = nodes.length
  if (n === 0) return []

  const index = new Map<string, number>()
  nodes.forEach((node, i) => index.set(node.id, i))

  // Out-edges per node (indices).
  const outLinks: number[][] = nodes.map(() => [])
  for (const edge of graph.edges()) {
    const from = index.get(edge.from)
    const to = index.get(edge.to)
    if (from === undefined || to === undefined) continue
    outLinks[from].push(to)
  }

  // Personalization / teleport vector.
  const seedIds = options.seeds ? resolveSeeds(graph, options.seeds) : new Set<string>()
  const teleport = new Array<number>(n).fill(0)
  if (seedIds.size > 0) {
    for (const id of seedIds) {
      const i = index.get(id)
      if (i !== undefined) teleport[i] = 1 / seedIds.size
    }
  } else {
    teleport.fill(1 / n)
  }

  let rank = new Array<number>(n).fill(1 / n)

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const next = new Array<number>(n).fill(0)
    let danglingMass = 0

    for (let i = 0; i < n; i++) {
      const links = outLinks[i]
      if (links.length === 0) {
        danglingMass += rank[i]
      } else {
        const share = rank[i] / links.length
        for (const target of links) next[target] += share
      }
    }

    let delta = 0
    for (let i = 0; i < n; i++) {
      const value =
        (1 - DAMPING) * teleport[i] + DAMPING * (next[i] + danglingMass * teleport[i])
      delta += Math.abs(value - rank[i])
      next[i] = value
    }
    rank = next
    if (delta < TOLERANCE) break
  }

  let ranked: RankedNode[] = nodes.map((node, i) => ({ node, score: rank[i] }))
  if (options.kind) {
    ranked = ranked.filter((r) => r.node.kind === options.kind)
  }
  ranked.sort((a, b) => b.score - a.score || compareIds(a.node, b.node))

  const limit = options.limit ?? 20
  return ranked.slice(0, Math.max(0, limit))
}

function compareIds(a: GraphNode, b: GraphNode): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

_registerRanker(computePageRank)

export { computePageRank }
