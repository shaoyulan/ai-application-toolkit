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
  /** A symbol (or file) references a declared symbol. */
  | 'references'

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
