---
"@ai-application-toolkit/codegraph": minor
---

Add a persistent, incremental index. `index`, `sync` and `serve` now keep a SQLite index that caches per-file parse results keyed by content hash, so unchanged files are never re-parsed — a warm rebuild is near-instant.

- **Zero-install on modern Node:** the SQLite backend is selected at runtime — `better-sqlite3` if installed, else Node's built-in `node:sqlite` (Node ≥ 23.4), else a graceful in-memory fallback for `serve`. Force one with `CODEGRAPH_SQLITE_DRIVER=node|better`.
- **Configurable index location:** defaults to `<dir>/.codegraph/index.db`; override with `--index <path>`, the `CODEGRAPH_INDEX` env var, or `--global` (store under `~/.cache/codegraph/`, keeping the repo clean).
- New CLI commands `index`, `sync`, `status`, and `list` (a repo's indexes, or `list --global` for every global-cache index, each labelled with its project). `serve` loads the persisted index and, by default, watches for changes and hot-swaps the served graph without a restart (`--no-watch` to disable). Each index records the repo it belongs to (`StoreMeta.root`).
- `buildCodeGraph` accepts a `store` and reports `onStats`. New exports: `GraphStore`, `SqliteGraphStore`, `SqliteDriver`, `openSqliteStore`, `watchDirectory`.
