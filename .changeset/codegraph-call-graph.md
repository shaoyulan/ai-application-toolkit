---
"@ai-application-toolkit/codegraph": minor
---

Add a scope-aware, confidence-scored **call graph** and impact analysis.

- New `calls` edges resolve each call site to the definition it invokes, with a **confidence** score (1.0 exact, 0.8 high, 0.5 medium). Resolution is precision-first: local/`this`/imported/`new X()`-and-typed-param method calls resolve with high confidence for TS/JS/Python; other languages resolve by name/uniqueness; ambiguous or cross-language calls are skipped (never mis-wired). The existing name-based `references` edges and `find_references` are unchanged.
- New MCP tools: `codegraph_callers`, `codegraph_callees`, `codegraph_impact` (full blast radius in one call — every transitive caller grouped by depth with confidence), and `codegraph_affected` (impacted test files).
- New library API: `CodeGraph.callers()`, `.callees()`, `.impact()`; `GraphEdge.meta` (confidence/kind/receiverType/callCount/line); exported `EdgeMeta`, `ImpactOptions`, `ImpactNode`, `ImpactResult`. `calls` edges also feed PageRank, improving `relevant_context`.
- Index schema bumped (2→3) for the richer parse facts; the existing version-mismatch migration rebuilds automatically.
