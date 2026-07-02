/**
 * The code graph data model and its query surface.
 *
 * A {@link CodeGraph} is an immutable view over a set of nodes (files and the
 * symbols they declare) and the typed edges between them. It is produced by
 * `buildCodeGraph` and consumed both directly (library API) and through the
 * tools exposed by `defineCodegraphCapability`.
 */

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'field'
  | 'variable'

/** Edge kinds, in dependency-graph terms. */
export type EdgeKind =
  /** A file declares a symbol. `from` = file, `to` = symbol. */
  | 'contains'
  /** A file imports another file. `from` = importer, `to` = imported. */
  | 'imports'
  /** A symbol (or file) references a declared symbol (name-based, coarse). */
  | 'references'
  /** A symbol calls another symbol (scope-aware, confidence-scored). */
  | 'calls'

/** Metadata carried by an edge (only `calls` edges use this today). */
export interface EdgeMeta {
  /** Resolution confidence for a `calls` edge: 1.0 exact, 0.8 high, 0.5 medium. */
  confidence?: number
  /** Whether the call is a constructor (`new X()`) vs a plain call. */
  kind?: 'call' | 'new'
  /** Resolved receiver type name for a method call, when known. */
  receiverType?: string
  /** Number of call sites collapsed into this edge. */
  callCount?: number
  /** 1-based line of the first call site. */
  line?: number
}

export interface FileNode {
  readonly id: string
  readonly kind: 'file'
  /** Repo-relative POSIX path, e.g. `src/parse.ts`. */
  readonly path: string
  /** Language id, e.g. `typescript`, `python`, `go`. */
  readonly language: string
}

export interface SymbolNode {
  readonly id: string
  readonly kind: 'symbol'
  readonly name: string
  readonly symbolKind: SymbolKind
  /** Repo-relative POSIX path of the declaring file. */
  readonly file: string
  /** 1-based line numbers. */
  readonly startLine: number
  readonly endLine: number
}

export type GraphNode = FileNode | SymbolNode

export interface GraphEdge {
  readonly from: string
  readonly to: string
  readonly kind: EdgeKind
  readonly meta?: EdgeMeta
}

export interface RankedContextOptions {
  /**
   * Optional symbol names or node ids to bias the ranking towards (personalized
   * PageRank). When omitted, global importance is used.
   */
  seeds?: string[]
  /** Maximum number of results. Default 20. */
  limit?: number
  /** Restrict results to a node kind. Default: both files and symbols. */
  kind?: GraphNode['kind']
}

export interface RankedNode {
  node: GraphNode
  score: number
}

export interface NeighborOptions {
  /** Follow outgoing edges. Default true. */
  outgoing?: boolean
  /** Follow incoming edges. Default true. */
  incoming?: boolean
  /** Restrict to these edge kinds. Default: all. */
  edgeKinds?: EdgeKind[]
}

export interface ImpactOptions {
  /** `callers` = who is impacted if this changes; `callees` = its dependencies. Default `callers`. */
  direction?: 'callers' | 'callees'
  /** Maximum traversal depth. Default 5. */
  maxDepth?: number
  /** Stop after this many reached nodes (sets `truncated`). Default 200. */
  maxNodes?: number
  /** Ignore `calls` edges below this confidence. Default 0. */
  minConfidence?: number
}

export interface ImpactNode {
  node: GraphNode
  /** Hops from the target (1 = direct caller/callee). */
  depth: number
  /** Weakest edge confidence along the shortest discovery path. */
  confidence: number
}

export interface ImpactResult {
  groups: { depth: number; nodes: ImpactNode[] }[]
  truncated: boolean
}

export interface SerializedCodeGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

let pageRank:
  | ((graph: CodeGraph, options?: RankedContextOptions) => RankedNode[])
  | undefined

/**
 * Lets `rank.ts` register the PageRank implementation without `graph.ts`
 * importing it (keeps the data model free of the numeric code and avoids a
 * cycle). `buildCodeGraph` imports both, so the implementation is always wired
 * up before a graph is returned to callers.
 */
export function _registerRanker(
  impl: (graph: CodeGraph, options?: RankedContextOptions) => RankedNode[]
): void {
  pageRank = impl
}

export class CodeGraph {
  private readonly nodesById: Map<string, GraphNode>
  private readonly edgeList: GraphEdge[]
  private readonly outgoing = new Map<string, GraphEdge[]>()
  private readonly incoming = new Map<string, GraphEdge[]>()
  /** symbol name -> ids of symbols declared with that name. */
  private readonly symbolsByName = new Map<string, string[]>()

  constructor(nodes: GraphNode[], edges: GraphEdge[]) {
    this.nodesById = new Map(nodes.map((n) => [n.id, n]))
    this.edgeList = edges

    for (const edge of edges) {
      ;(this.outgoing.get(edge.from) ?? this.setAndGet(this.outgoing, edge.from)).push(edge)
      ;(this.incoming.get(edge.to) ?? this.setAndGet(this.incoming, edge.to)).push(edge)
    }

    for (const node of nodes) {
      if (node.kind === 'symbol') {
        ;(this.symbolsByName.get(node.name) ?? this.setAndGet(this.symbolsByName, node.name)).push(
          node.id
        )
      }
    }
  }

  private setAndGet<V>(map: Map<string, V[]>, key: string): V[] {
    const arr: V[] = []
    map.set(key, arr)
    return arr
  }

  /** All nodes in the graph. */
  nodes(): GraphNode[] {
    return [...this.nodesById.values()]
  }

  /** All edges in the graph. */
  edges(): GraphEdge[] {
    return [...this.edgeList]
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodesById.get(id)
  }

  files(): FileNode[] {
    return this.nodes().filter((n): n is FileNode => n.kind === 'file')
  }

  symbols(): SymbolNode[] {
    return this.nodes().filter((n): n is SymbolNode => n.kind === 'symbol')
  }

  /** Symbols declared with the given name. */
  findDefinition(name: string): SymbolNode[] {
    return (this.symbolsByName.get(name) ?? [])
      .map((id) => this.nodesById.get(id))
      .filter((n): n is SymbolNode => n?.kind === 'symbol')
  }

  /**
   * Returns the symbols and files that reference the given symbol. Accepts a
   * symbol node id or a bare symbol name (in which case every same-named
   * symbol's referrers are merged).
   */
  findReferences(symbolIdOrName: string): GraphNode[] {
    const targetIds =
      this.nodesById.has(symbolIdOrName)
        ? [symbolIdOrName]
        : (this.symbolsByName.get(symbolIdOrName) ?? [])

    const referrers = new Map<string, GraphNode>()
    for (const id of targetIds) {
      for (const edge of this.incoming.get(id) ?? []) {
        if (edge.kind !== 'references') continue
        const node = this.nodesById.get(edge.from)
        if (node) referrers.set(node.id, node)
      }
    }
    return [...referrers.values()]
  }

  /** Nodes directly connected to `id` along the requested edges. */
  neighbors(id: string, options: NeighborOptions = {}): GraphNode[] {
    const { outgoing = true, incoming = true, edgeKinds } = options
    const allowed = edgeKinds ? new Set(edgeKinds) : undefined
    const result = new Map<string, GraphNode>()

    const collect = (edges: GraphEdge[] | undefined, pick: (e: GraphEdge) => string) => {
      for (const edge of edges ?? []) {
        if (allowed && !allowed.has(edge.kind)) continue
        const node = this.nodesById.get(pick(edge))
        if (node) result.set(node.id, node)
      }
    }

    if (outgoing) collect(this.outgoing.get(id), (e) => e.to)
    if (incoming) collect(this.incoming.get(id), (e) => e.from)
    return [...result.values()]
  }

  /** Edges leaving `id`. */
  edgesFrom(id: string): GraphEdge[] {
    return [...(this.outgoing.get(id) ?? [])]
  }

  /** Edges arriving at `id`. */
  edgesTo(id: string): GraphEdge[] {
    return [...(this.incoming.get(id) ?? [])]
  }

  /** Node ids for an exact node id or a bare symbol name. */
  private idsFor(idOrName: string): string[] {
    return this.nodesById.has(idOrName) ? [idOrName] : (this.symbolsByName.get(idOrName) ?? [])
  }

  /** Direct callees — the symbols the given symbol calls. */
  callees(idOrName: string): GraphNode[] {
    return this.callNeighbors(idOrName, 'out')
  }

  /** Direct callers — the symbols that call the given symbol. */
  callers(idOrName: string): GraphNode[] {
    return this.callNeighbors(idOrName, 'in')
  }

  private callNeighbors(idOrName: string, dir: 'in' | 'out'): GraphNode[] {
    const result = new Map<string, GraphNode>()
    for (const id of this.idsFor(idOrName)) {
      const edges = (dir === 'out' ? this.outgoing : this.incoming).get(id) ?? []
      for (const edge of edges) {
        if (edge.kind !== 'calls') continue
        const node = this.nodesById.get(dir === 'out' ? edge.to : edge.from)
        if (node) result.set(node.id, node)
      }
    }
    return [...result.values()]
  }

  /**
   * Blast radius over the call graph: transitively follow `calls` edges from the
   * given symbol (`callers` = who is impacted if it changes; `callees` = what it
   * depends on), returning reached symbols grouped by depth with a confidence
   * (the weakest edge along the shortest discovery path). Bounded by
   * `maxDepth`/`maxNodes`; edges below `minConfidence` are ignored.
   */
  impact(idOrName: string, options: ImpactOptions = {}): ImpactResult {
    const direction = options.direction ?? 'callers'
    const maxDepth = options.maxDepth ?? 5
    const maxNodes = options.maxNodes ?? 200
    const minConfidence = options.minConfidence ?? 0
    const edgesOf = direction === 'callers' ? this.incoming : this.outgoing
    const pick = (e: GraphEdge) => (direction === 'callers' ? e.from : e.to)

    const seen = new Set<string>(this.idsFor(idOrName))
    let frontier = [...seen].map((id) => ({ id, confidence: 1 }))
    const reached: ImpactNode[] = []
    let truncated = false

    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const next = new Map<string, number>()
      for (const { id, confidence } of frontier) {
        for (const edge of (edgesOf.get(id) ?? [])) {
          if (edge.kind !== 'calls') continue
          const edgeConf = edge.meta?.confidence ?? 0
          if (edgeConf < minConfidence) continue
          const nextId = pick(edge)
          if (seen.has(nextId)) continue
          const pathConf = Math.min(confidence, edgeConf)
          next.set(nextId, Math.max(next.get(nextId) ?? 0, pathConf))
        }
      }
      const sorted = [...next.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      for (const [id, confidence] of sorted) {
        if (reached.length >= maxNodes) { truncated = true; break }
        seen.add(id)
        const node = this.nodesById.get(id)
        if (node) reached.push({ node, depth, confidence })
      }
      frontier = sorted.filter(([id]) => seen.has(id) && this.nodesById.has(id)).map(([id, confidence]) => ({ id, confidence }))
      if (truncated) break
    }

    const byDepth = new Map<number, ImpactNode[]>()
    for (const item of reached) {
      const list = byDepth.get(item.depth)
      if (list) list.push(item)
      else byDepth.set(item.depth, [item])
    }
    const groups = [...byDepth.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([depth, nodes]) => ({ depth, nodes }))
    return { groups, truncated }
  }

  /** The symbols a file declares plus the files it imports. */
  fileSummary(path: string): {
    file: FileNode
    symbols: SymbolNode[]
    imports: FileNode[]
  } | undefined {
    const file = this.nodes().find((n): n is FileNode => n.kind === 'file' && n.path === path)
    if (!file) return undefined

    const symbols: SymbolNode[] = []
    const imports: FileNode[] = []
    for (const edge of this.outgoing.get(file.id) ?? []) {
      const target = this.nodesById.get(edge.to)
      if (!target) continue
      if (edge.kind === 'contains' && target.kind === 'symbol') symbols.push(target)
      else if (edge.kind === 'imports' && target.kind === 'file') imports.push(target)
    }
    return { file, symbols, imports }
  }

  /**
   * Ranks nodes by importance using PageRank over the reference/import graph.
   * This is the primary entry point for building LLM context: pass the symbols
   * you already care about as `seeds` to get the most relevant neighbourhood.
   */
  rankedContext(options: RankedContextOptions = {}): RankedNode[] {
    if (!pageRank) {
      throw new Error('Ranker not registered; import @ai-application-toolkit/codegraph entrypoint')
    }
    return pageRank(this, options)
  }

  toJSON(): SerializedCodeGraph {
    return { nodes: this.nodes(), edges: this.edges() }
  }

  static fromJSON(data: SerializedCodeGraph): CodeGraph {
    return new CodeGraph(data.nodes, data.edges)
  }
}
