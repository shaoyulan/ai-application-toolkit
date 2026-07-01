---
"@ai-application-toolkit/tool": patch
"@ai-application-toolkit/mcp": patch
---

Add explicit `.js` extensions to relative imports so the emitted ESM resolves
under plain Node (not just bundlers/tsx). Previously `tool` and `mcp` emitted
extensionless relative imports (e.g. `export * from './schema'`), which Node's
native ESM loader rejects — breaking `node dist/...` and any consumer that runs
the built output directly (such as a CLI bin). No API changes.
