#!/usr/bin/env node
/**
 * codegraph CLI — `npx @ai-application-toolkit/codegraph <command>`.
 *
 *   codegraph build  <dir> [--json] [--lang ts,py] [--limit N]
 *   codegraph index  <dir> [--lang …] [--force]      Persist an incremental index
 *   codegraph sync   <dir> [--lang …]                Update the index in place
 *   codegraph status <dir>                           Show index freshness
 *   codegraph serve  <dir> [--port 3000] [--path /mcp] [--tunnel] [--no-watch] [--lang …]
 *
 * `index`/`sync`/`serve` persist a SQLite index under `<dir>/.codegraph/` so
 * unchanged files are never re-parsed. `serve` exposes the graph as an MCP server
 * over Streamable HTTP and (by default) watches for changes and hot-swaps the
 * served graph. `--tunnel` publishes a public URL via untun.
 *
 * `@ai-application-toolkit/mcp` (serve), `untun` (--tunnel) and `better-sqlite3`
 * (persistence) are optional dependencies, imported lazily so `build` stays
 * lightweight and installs stay soft.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { collectCapabilityTools } from '@ai-application-toolkit/capability'
import { buildCodeGraph, type BuildCodeGraphOptions, type BuildStats } from './build.js'
import type { CodeGraph } from './graph.js'
import { findAvailablePort } from './port.js'
import type { GraphStore } from './store.js'
import { openSqliteStore } from './store.sqlite.js'
import { defineCodegraphCapability } from './tools.js'
import { watchDirectory, type Watcher } from './watch.js'

const DEFAULT_PORT = 3000

interface Flags {
  positionals: string[]
  json: boolean
  tunnel: boolean
  help: boolean
  version: boolean
  force: boolean
  global: boolean
  watch?: boolean
  port?: number
  path?: string
  index?: string
  lang?: string[]
  limit?: number
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { positionals: [], json: false, tunnel: false, help: false, version: false, force: false, global: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--json': flags.json = true; break
      case '--tunnel': flags.tunnel = true; break
      case '--force': flags.force = true; break
      case '--global': flags.global = true; break
      case '--watch': flags.watch = true; break
      case '--no-watch': flags.watch = false; break
      case '--help': case '-h': flags.help = true; break
      case '--version': case '-v': flags.version = true; break
      case '--port': flags.port = Number(argv[++i]); break
      case '--path': flags.path = argv[++i]; break
      case '--index': flags.index = argv[++i]; break
      case '--lang': flags.lang = argv[++i]?.split(',').map((s) => s.trim()).filter(Boolean); break
      case '--limit': flags.limit = Number(argv[++i]); break
      default:
        if (arg.startsWith('-')) fail(`Unknown option: ${arg}`)
        else flags.positionals.push(arg)
    }
  }
  return flags
}

function fail(message: string): never {
  console.error(`codegraph: ${message}`)
  process.exit(1)
}

const HELP = `codegraph — turn a folder into a multi-language code graph

Usage:
  codegraph build  <dir> [options]   Build the graph and print a summary (in-memory)
  codegraph index  <dir> [options]   Build/update a persistent incremental index
  codegraph sync   <dir> [options]   Update the persistent index in place
  codegraph status <dir>             Show the persistent index's freshness
  codegraph list   [dir] [--global]  List indexes for a repo, or all global ones
  codegraph serve  <dir> [options]   Serve the graph as an MCP server (HTTP)

Options:
  --json            (build) Print the full graph as JSON to stdout
  --limit <n>       (build) Number of ranked symbols to show (default 10)
  --lang <a,b>      Restrict to language ids (e.g. typescript,python,csharp)
  --force           (index) Rebuild from scratch, ignoring the cache
  --index <path>    (index/sync/status/serve) Index file location
                    (default <dir>/.codegraph/index.db; or set CODEGRAPH_INDEX)
  --global          (index/sync/status/serve) Store the index in the user cache
                    dir (~/.cache/codegraph/) instead of inside the project
  --port <n>        (serve) HTTP port. Omit to auto-select a free port from 3000;
                    if a given port is busy, the next free port is used.
  --path <p>        (serve) MCP endpoint path (default /mcp)
  --tunnel          (serve) Publish a public URL via untun (Cloudflare tunnel)
  --no-watch        (serve) Do not watch for changes / hot-swap the graph
  -h, --help        Show this help
  -v, --version     Show version

Persistence: index/sync/serve store a SQLite index under <dir>/.codegraph/
(requires the optional dependency "better-sqlite3"). Serve falls back to an
in-memory build if it is unavailable.

Examples:
  npx @ai-application-toolkit/codegraph index ./src
  npx @ai-application-toolkit/codegraph status ./src
  npx @ai-application-toolkit/codegraph serve ./src --port 3030 --tunnel`

async function readVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function buildOptions(dir: string, flags: Flags): BuildCodeGraphOptions {
  return { dir, ...(flags.lang ? { languages: flags.lang } : {}) }
}

/**
 * Where the SQLite index lives. Precedence: `--index <path>` >
 * `CODEGRAPH_INDEX` env > `--global` (a per-project file under the user cache
 * dir, keeping the repo clean) > the default `<dir>/.codegraph/index.db`.
 */
const globalCacheDir = (): string => join(homedir(), '.cache', 'codegraph')
const localIndexPath = (dir: string): string => join(dir, '.codegraph', 'index.db')
const globalIndexPath = (dir: string): string =>
  join(globalCacheDir(), `${createHash('sha1').update(dir).digest('hex').slice(0, 16)}.db`)

function resolveIndexPath(dir: string, flags: Flags): string {
  if (flags.index) return resolve(process.cwd(), flags.index)
  if (process.env.CODEGRAPH_INDEX) return resolve(process.cwd(), process.env.CODEGRAPH_INDEX)
  if (flags.global) return globalIndexPath(dir)
  return localIndexPath(dir)
}

function describeStats(stats: BuildStats): string {
  const parts = [`parsed ${stats.parsed}`, `reused ${stats.reused}`]
  if (stats.deleted > 0) parts.push(`removed ${stats.deleted}`)
  return parts.join(', ')
}

async function cmdBuild(dir: string, flags: Flags): Promise<void> {
  const graph = await buildCodeGraph(buildOptions(dir, flags))

  if (flags.json) {
    process.stdout.write(JSON.stringify(graph.toJSON(), null, 2) + '\n')
    return
  }

  const langs = new Map<string, number>()
  for (const f of graph.files()) langs.set(f.language, (langs.get(f.language) ?? 0) + 1)

  console.log(`Indexed ${graph.files().length} files, ${graph.symbols().length} symbols, ${graph.edges().length} edges.`)
  console.log('Languages: ' + [...langs].map(([l, n]) => `${l}=${n}`).join(', '))
  console.log(`\nTop ${flags.limit ?? 10} symbols (PageRank):`)
  for (const { node, score } of graph.rankedContext({ kind: 'symbol', limit: flags.limit ?? 10 })) {
    if (node.kind === 'symbol') {
      console.log(`  ${score.toFixed(4)}  ${node.symbolKind.padEnd(9)} ${node.name}  [${node.file}:${node.startLine}]`)
    }
  }
}

async function cmdIndex(dir: string, flags: Flags): Promise<void> {
  const dbPath = resolveIndexPath(dir, flags)
  if (flags.force && existsSync(dbPath)) {
    const { rmSync } = await import('node:fs')
    rmSync(dbPath, { force: true })
    for (const suffix of ['-wal', '-shm']) rmSync(dbPath + suffix, { force: true })
  }
  const store = openSqliteStore(dbPath)
  try {
    let stats: BuildStats | undefined
    const graph = await buildCodeGraph({ ...buildOptions(dir, flags), store, onStats: (s) => (stats = s) })
    console.log(
      `Indexed ${graph.files().length} files (${describeStats(stats!)}), ` +
        `${graph.symbols().length} symbols, ${graph.edges().length} edges.`
    )
    console.log(`Index: ${dbPath} (${store.driver})`)
  } finally {
    store.close()
  }
}

async function cmdStatus(dir: string, flags: Flags): Promise<void> {
  const dbPath = resolveIndexPath(dir, flags)
  if (!existsSync(dbPath)) {
    console.log(`No index found at ${dbPath}. Run "codegraph index ${dir}" first.`)
    return
  }
  const store = openSqliteStore(dbPath)
  try {
    const meta = store.meta()
    const hashes = store.getFileHashes()
    const graph = store.loadGraph()
    const sizeMb = (statSync(dbPath).size / 1_000_000).toFixed(2)
    console.log(`Index: ${dbPath} (${sizeMb} MB, ${store.driver})`)
    console.log(`Cached files: ${hashes.size}`)
    if (graph) console.log(`Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`)
    if (meta) {
      console.log(`Schema v${meta.schemaVersion}, tree-sitter ${meta.treeSitterVersion}`)
    }
  } finally {
    store.close()
  }
}

interface IndexInfo {
  path: string
  root?: string
  files: number
  sizeMb: string
  driver: string
  error?: string
}

/** Read a summary of an index file, or undefined if it doesn't exist. */
function readIndexInfo(dbPath: string): IndexInfo | undefined {
  if (!existsSync(dbPath)) return undefined
  const sizeMb = (statSync(dbPath).size / 1_000_000).toFixed(2)
  try {
    const store = openSqliteStore(dbPath)
    try {
      const meta = store.meta()
      return { path: dbPath, root: meta?.root, files: store.getFileHashes().size, sizeMb, driver: store.driver }
    } finally {
      store.close()
    }
  } catch (error) {
    return { path: dbPath, files: 0, sizeMb, driver: '?', error: error instanceof Error ? error.message : String(error) }
  }
}

function printIndexInfo(info: IndexInfo): void {
  if (info.error) {
    console.log(`  ${info.path}\n    (unreadable: ${info.error})`)
    return
  }
  console.log(`  ${info.root ?? '(unknown repo)'}`)
  console.log(`    ${info.files} files, ${info.sizeMb} MB, ${info.driver} — ${info.path}`)
}

async function cmdList(dir: string | undefined, flags: Flags): Promise<void> {
  if (flags.global) {
    const cacheDir = globalCacheDir()
    const files = existsSync(cacheDir) ? readdirSync(cacheDir).filter((f) => f.endsWith('.db')) : []
    if (files.length === 0) {
      console.log(`Global cache is empty (${cacheDir}).`)
      return
    }
    console.log(`Global cache (${cacheDir}):`)
    for (const f of files) {
      const info = readIndexInfo(join(cacheDir, f))
      if (info) printIndexInfo(info)
    }
    return
  }

  // Caches associated with a specific repo: local, global, and any explicit path.
  const target = dir ?? process.cwd()
  const candidates = new Set<string>([localIndexPath(target), globalIndexPath(target)])
  if (flags.index) candidates.add(resolve(process.cwd(), flags.index))
  if (process.env.CODEGRAPH_INDEX) candidates.add(resolve(process.cwd(), process.env.CODEGRAPH_INDEX))

  const found = [...candidates].map(readIndexInfo).filter((i): i is IndexInfo => i !== undefined)
  if (found.length === 0) {
    console.log(`No index found for ${target}. Run "codegraph index ${dir ?? '.'}".`)
    return
  }
  console.log(`Indexes for ${target}:`)
  for (const info of found) printIndexInfo(info)
}

async function cmdServe(dir: string, flags: Flags): Promise<void> {
  const mcp = await import('@ai-application-toolkit/mcp').catch(() =>
    fail('serve requires the optional dependency "@ai-application-toolkit/mcp" (npm i @ai-application-toolkit/mcp)')
  )

  // Persistence is best-effort: if better-sqlite3 is unavailable, serve still
  // works from an in-memory build (without incremental caching / hot-swap).
  let store: GraphStore | undefined
  try {
    store = openSqliteStore(resolveIndexPath(dir, flags))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`${reason}\nServing from an in-memory build (no incremental cache).`)
  }

  const options: BuildCodeGraphOptions = { ...buildOptions(dir, flags), ...(store ? { store } : {}) }
  let graph: CodeGraph = await buildCodeGraph({ ...options, onStats: (s) => console.log(`(${describeStats(s)})`) })
  console.log(`Indexed ${graph.files().length} files, ${graph.symbols().length} symbols.`)

  const capability = defineCodegraphCapability(() => graph)
  const path = flags.path ?? '/mcp'

  const preferredPort = flags.port ?? DEFAULT_PORT
  const chosenPort = await findAvailablePort(preferredPort)
  if (flags.port !== undefined && chosenPort !== flags.port) {
    const target = chosenPort === 0 ? 'an OS-assigned free port' : `port ${chosenPort}`
    console.warn(`Port ${flags.port} is already in use — falling back to ${target}.`)
  }

  const server = await mcp.startHttpMcpServer({
    name: 'codegraph-mcp',
    version: await readVersion(),
    tools: collectCapabilityTools([capability]),
    port: chosenPort,
    path
  })

  // Read the actually-bound port (authoritative when chosenPort was 0).
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : chosenPort
  const localUrl = `http://localhost:${port}${path}`
  console.log(`\nMCP server listening on ${localUrl}`)
  console.log('Tools: ' + capability.tools.map((t) => t.id).join(', '))

  let watcher: Watcher | undefined
  if (store && flags.watch !== false) {
    watcher = watchDirectory(
      dir,
      async () => {
        graph = await buildCodeGraph(options)
        console.log(`Re-synced: ${graph.files().length} files, ${graph.symbols().length} symbols.`)
      },
      { onError: (error) => console.warn('watch:', error instanceof Error ? error.message : error) }
    )
    console.log('Watching for changes… (--no-watch to disable)')
  }

  let tunnel: { getURL(): Promise<string>; close(): Promise<void> } | undefined
  if (flags.tunnel) {
    const untun = await import('untun').catch(() =>
      fail('--tunnel requires the optional dependency "untun" (npm i untun)')
    )
    console.log('\nStarting tunnel via untun (Cloudflare)…')
    tunnel = await untun.startTunnel({ port, hostname: 'localhost' })
    const publicUrl = await tunnel?.getURL()
    console.log(`Public URL: ${publicUrl}${path}`)
  }

  const shutdown = async () => {
    console.log('\nShutting down…')
    watcher?.close()
    if (tunnel) await tunnel.close().catch(() => {})
    server.close()
    store?.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2))

  if (flags.version) {
    console.log(await readVersion())
    return
  }
  const [command, dirArg] = flags.positionals
  if (flags.help || !command) {
    console.log(HELP)
    return
  }
  const commands = ['build', 'index', 'sync', 'status', 'serve', 'list']
  if (!commands.includes(command)) fail(`Unknown command: ${command}`)
  // `list` works without a <dir> (e.g. `list --global`, or the current repo).
  if (!dirArg && command !== 'list') fail(`${command} requires a <dir> argument`)
  const dir = dirArg ? resolve(process.cwd(), dirArg) : undefined

  switch (command) {
    case 'build': await cmdBuild(dir!, flags); break
    case 'index': case 'sync': await cmdIndex(dir!, flags); break
    case 'status': await cmdStatus(dir!, flags); break
    case 'serve': await cmdServe(dir!, flags); break
    case 'list': await cmdList(dir, flags); break
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
