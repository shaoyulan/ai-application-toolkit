# @ai-application-toolkit/codegraph

## 0.2.0

### Minor Changes

- 86a7e30: codegraph `serve` now auto-selects a free port. Omitting `--port` picks the first free port from 3000, and an explicitly requested but busy port warns and falls back to the next free one. Port conflicts are detected via a connect-probe on both loopback stacks (127.0.0.1 and ::1), which catches the case where a wildcard bind silently coexists with an existing listener on a specific loopback address. `startHttpMcpServer` now rejects on listen errors instead of hanging.

## 0.1.1

### Patch Changes

- Updated dependencies [c98654b]
  - @ai-application-toolkit/core@0.1.1
  - @ai-application-toolkit/capability@0.1.1
  - @ai-application-toolkit/tool@0.1.1

## 0.1.0

### Minor Changes

- ef4faa4: Add a `codegraph` CLI (runnable via `npx @ai-application-toolkit/codegraph`):

  - `codegraph build <dir>` — build the graph and print a summary, the top
    PageRank-ranked symbols, or the full graph as JSON (`--json`). `--lang`
    restricts languages.
  - `codegraph serve <dir>` — expose the graph as an MCP server over Streamable
    HTTP. `--tunnel` additionally publishes a public URL via untun (Cloudflare
    quick tunnel).

  `@ai-application-toolkit/mcp` (for `serve`) and `untun` (for `--tunnel`) are
  optional dependencies, imported lazily so `build` stays lightweight.

- ef4faa4: Add C# (`.cs`), Java (`.java`) and Rust (`.rs`) language support. The grammars
  ship with `@vscode/tree-sitter-wasm`, so no new dependency is needed — each
  language is a `LanguageSpec` plus tag-query patterns for its definitions and
  references. Symbols (classes/interfaces/enums/methods/functions/structs) and
  name-based `references` edges are extracted; `imports` edges are not inferred
  for these namespace/module-based languages.
- ef4faa4: New package: turn a folder of source code into a queryable, multi-language code
  graph.

  - **`buildCodeGraph({ dir })`** walks a folder and parses every supported file
    with tree-sitter (WASM, no native build) — TypeScript, TSX, JavaScript,
    Python and Go — extracting files, symbols, imports and references.
  - **`CodeGraph`** exposes `findDefinition`, `findReferences`, `neighbors`,
    `fileSummary`, JSON (de)serialization, and **`rankedContext({ seeds })`** —
    personalized PageRank over the import/reference graph for selecting the most
    relevant code to feed an LLM.
  - **`defineCodegraphCapability(graph)`** wraps the query surface as toolkit
    Tools (`codegraph_search_symbols`, `codegraph_find_definition`,
    `codegraph_find_references`, `codegraph_neighbors`, `codegraph_file_summary`,
    `codegraph_relevant_context`) so a Runtime/LLM can explore the graph.

  Import and reference resolution is best-effort and high-precision: ambiguous
  cross-file names are skipped rather than guessed.

### Patch Changes

- Updated dependencies [ef4faa4]
- Updated dependencies [ef4faa4]
- Updated dependencies [b556a67]
  - @ai-application-toolkit/tool@0.1.0
  - @ai-application-toolkit/core@0.1.0
  - @ai-application-toolkit/capability@0.1.0
