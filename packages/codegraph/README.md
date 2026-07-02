# @ai-application-toolkit/codegraph

Turn a folder of source code into a queryable, multi-language **code graph** —
files, symbols, imports and references — built with [tree-sitter], plus
PageRank context ranking for feeding the right code to an LLM.

Part of the [AI Application Toolkit](https://github.com/shaoyulan/ai-application-toolkit#readme).

## Install

```bash
pnpm add @ai-application-toolkit/codegraph
```

Grammars ship as WebAssembly via `tree-sitter-wasms` — no native build step.

## Supported languages

TypeScript (`.ts`/`.mts`/`.cts`), TSX, JavaScript (`.js`/`.jsx`/`.mjs`/`.cjs`),
Python, Go, C# (`.cs`), Java and Rust. Adding a language is a grammar `.wasm`
plus a set of tag-query patterns — the core does not change.

Import resolution is file-path based for the JS family (relative imports) and
Python; C#, Java, Go and Rust use namespace/module imports, so cross-file
`imports` edges are not inferred for them — but `contains` and (name-based)
`references` edges are.

## CLI (npx)

```bash
# Build a graph and print a summary + the top-ranked symbols
npx @ai-application-toolkit/codegraph build ./src

# Dump the full graph as JSON
npx @ai-application-toolkit/codegraph build ./src --json > graph.json

# Restrict languages
npx @ai-application-toolkit/codegraph build ./src --lang typescript,python,csharp

# Build/update a persistent, incremental index under ./src/.codegraph/
# (unchanged files are never re-parsed — a warm run is near-instant)
npx @ai-application-toolkit/codegraph index ./src
npx @ai-application-toolkit/codegraph status ./src   # freshness, size, counts

# Serve the graph as an MCP server over HTTP …
# (omit --port to auto-select a free port from 3000; a busy --port falls back to the next free one)
# serve loads the persistent index and watches for changes, hot-swapping the
# graph on edits — pass --no-watch to disable.
npx @ai-application-toolkit/codegraph serve ./src --port 3000

# … and publish a public URL via untun (Cloudflare quick tunnel)
npx @ai-application-toolkit/codegraph serve ./src --tunnel
```

`serve` needs the optional dependency `@ai-application-toolkit/mcp`, and
`--tunnel` needs `untun`; both are imported lazily so `build` stays lightweight.
On its first run `--tunnel` downloads `cloudflared` and prompts you to accept
its license, so run it in an interactive terminal.

### Persistent index

`index`, `sync` and `serve` keep a SQLite index that caches per-file parse
results keyed by content hash, so only changed files are re-parsed (a warm
rebuild is near-instant).

**No install needed on modern Node.** The SQLite backend is chosen at runtime:

1. `better-sqlite3` if it is installed (stable, quiet), else
2. Node's built-in **`node:sqlite`** (Node ≥ 23.4) — zero dependency, else
3. `serve` falls back to a plain in-memory build (no cache).

So on recent Node it just works; on older Node run `npm i better-sqlite3`. Force
a backend with `CODEGRAPH_SQLITE_DRIVER=node` (skip the native module) or
`=better`.

**Index location.** Defaults to `<dir>/.codegraph/index.db` (add `.codegraph/`
to `.gitignore`). Override with:

- `--index <path>` — an explicit file, or set `CODEGRAPH_INDEX`
- `--global` — store under `~/.cache/codegraph/` (per project), keeping the repo
  clean

```bash
npx @ai-application-toolkit/codegraph index ./src --global
npx @ai-application-toolkit/codegraph serve ./src --index /tmp/mygraph.db
```

## Library API

```ts
import { buildCodeGraph } from '@ai-application-toolkit/codegraph'

const graph = await buildCodeGraph({ dir: './src' })

graph.findDefinition('buildCodeGraph') // where is it declared?
graph.findReferences('CodeGraph')      // who uses it?
graph.fileSummary('src/build.ts')      // symbols + imported files

// "What matters around what I'm editing?" — ranked context for an LLM:
graph.rankedContext({ seeds: ['parseFile'], limit: 15 })
```

## As tools / capability

```ts
import { buildCodeGraph, defineCodegraphCapability } from '@ai-application-toolkit/codegraph'
import { collectCapabilityTools } from '@ai-application-toolkit/capability'
import { createRuntime } from '@ai-application-toolkit/runtime'

const graph = await buildCodeGraph({ dir: './src' })
const codegraph = defineCodegraphCapability(graph)

const runtime = createRuntime({ tools: collectCapabilityTools([codegraph]) })
// Tools: codegraph_search_symbols, codegraph_find_definition,
//        codegraph_find_references, codegraph_neighbors,
//        codegraph_file_summary, codegraph_relevant_context
```

## Ask your codebase (RAG)

`rankedContext` is built for retrieval: derive seeds from a question, let
personalized PageRank surface the relevant symbols, read their source, and hand
that to a model adapter.

```ts
const graph = await buildCodeGraph({ dir: './src' })
const ranked = graph.rankedContext({ seeds: ['rankedContext'], kind: 'symbol', limit: 6 })
// -> rankedContext, computePageRank, RankedContextOptions, … (the ranking code)
// read each symbol's startLine..endLine, pack into a prompt, call your adapter
```

A runnable end-to-end version (codegraph retrieval → Claude) lives in
[`examples/codegraph-qa.ts`](https://github.com/shaoyulan/ai-application-toolkit/blob/main/examples/codegraph-qa.ts).

## Serve over MCP

Because the capability is just toolkit tools, you can expose the whole graph as
an MCP server — any MCP client (Claude Desktop, the MCP Inspector, another
agent) can then explore the codebase remotely:

```ts
import { startHttpMcpServer } from '@ai-application-toolkit/mcp'

const graph = await buildCodeGraph({ dir: './src' })
await startHttpMcpServer({
  name: 'codegraph-mcp',
  version: '1.0.0',
  tools: defineCodegraphCapability(graph).tools,
  port: 3000
})
// Streamable HTTP at http://localhost:3000/mcp
```

Runnable: [`examples/codegraph-mcp-http.ts`](https://github.com/shaoyulan/ai-application-toolkit/blob/main/examples/codegraph-mcp-http.ts).

## How it works

`buildCodeGraph` walks the folder, parses each file with tree-sitter, and
extracts symbols, references and imports using tag queries. Import and
reference edges are resolved **best-effort and high-precision**: ambiguous
cross-file names are skipped rather than guessed, which keeps the graph clean
for context selection. `rankedContext` runs PageRank (personalized when you
pass `seeds`) over the import/reference graph.

## License

MIT © Danny LAN

[tree-sitter]: https://tree-sitter.github.io/tree-sitter/
