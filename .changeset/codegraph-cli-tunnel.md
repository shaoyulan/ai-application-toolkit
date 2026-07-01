---
"@ai-application-toolkit/codegraph": minor
---

Add a `codegraph` CLI (runnable via `npx @ai-application-toolkit/codegraph`):

- `codegraph build <dir>` — build the graph and print a summary, the top
  PageRank-ranked symbols, or the full graph as JSON (`--json`). `--lang`
  restricts languages.
- `codegraph serve <dir>` — expose the graph as an MCP server over Streamable
  HTTP. `--tunnel` additionally publishes a public URL via untun (Cloudflare
  quick tunnel).

`@ai-application-toolkit/mcp` (for `serve`) and `untun` (for `--tunnel`) are
optional dependencies, imported lazily so `build` stays lightweight.
