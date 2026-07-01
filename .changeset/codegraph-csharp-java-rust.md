---
"@ai-application-toolkit/codegraph": minor
---

Add C# (`.cs`), Java (`.java`) and Rust (`.rs`) language support. The grammars
ship with `@vscode/tree-sitter-wasm`, so no new dependency is needed — each
language is a `LanguageSpec` plus tag-query patterns for its definitions and
references. Symbols (classes/interfaces/enums/methods/functions/structs) and
name-based `references` edges are extracted; `imports` edges are not inferred
for these namespace/module-based languages.
