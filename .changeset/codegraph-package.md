---
"@ai-application-toolkit/codegraph": minor
---

New package: turn a folder of source code into a queryable, multi-language code
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
