---
"@ai-application-toolkit/codegraph": minor
---

Add a persistent, incremental index. `index`, `sync` and `serve` now keep a SQLite index (optional dependency `better-sqlite3`) under `<dir>/.codegraph/`, caching per-file parse results keyed by content hash so unchanged files are never re-parsed — a warm rebuild is near-instant. New CLI commands `index`, `sync` and `status`; `serve` loads the persisted index and, by default, watches for changes and hot-swaps the served graph without a restart (`--no-watch` to disable). `buildCodeGraph` accepts a `store` and reports `onStats`; new exports: `GraphStore`, `SqliteGraphStore`, `openSqliteStore`, `watchDirectory`. When `better-sqlite3` is unavailable, `serve` degrades gracefully to an in-memory build.
