#!/usr/bin/env node
/**
 * codegraph CLI — `npx @ai-application-toolkit/codegraph <command>`.
 *
 *   codegraph build <dir> [--json] [--lang ts,py] [--limit N]
 *   codegraph serve <dir> [--port 3000] [--path /mcp] [--tunnel] [--lang …]
 *
 * `serve` exposes the graph as an MCP server over Streamable HTTP. `--tunnel`
 * additionally publishes a public URL via untun (Cloudflare quick tunnel).
 *
 * `@ai-application-toolkit/mcp` (for serve) and `untun` (for --tunnel) are
 * optional dependencies, imported lazily so `build` stays lightweight.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { collectCapabilityTools } from '@ai-application-toolkit/capability'
import { buildCodeGraph, type BuildCodeGraphOptions } from './build.js'
import { defineCodegraphCapability } from './tools.js'

interface Flags {
  positionals: string[]
  json: boolean
  tunnel: boolean
  help: boolean
  version: boolean
  port?: number
  path?: string
  lang?: string[]
  limit?: number
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { positionals: [], json: false, tunnel: false, help: false, version: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--json': flags.json = true; break
      case '--tunnel': flags.tunnel = true; break
      case '--help': case '-h': flags.help = true; break
      case '--version': case '-v': flags.version = true; break
      case '--port': flags.port = Number(argv[++i]); break
      case '--path': flags.path = argv[++i]; break
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
  codegraph build <dir> [options]    Build the graph and print a summary
  codegraph serve <dir> [options]    Serve the graph as an MCP server (HTTP)

Options:
  --json            (build) Print the full graph as JSON to stdout
  --limit <n>       (build) Number of ranked symbols to show (default 10)
  --lang <a,b>      Restrict to language ids (e.g. typescript,python,csharp)
  --port <n>        (serve) HTTP port (default 3000)
  --path <p>        (serve) MCP endpoint path (default /mcp)
  --tunnel          (serve) Publish a public URL via untun (Cloudflare tunnel)
  -h, --help        Show this help
  -v, --version     Show version

Examples:
  npx @ai-application-toolkit/codegraph build ./src
  npx @ai-application-toolkit/codegraph build ./src --json > graph.json
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

async function cmdServe(dir: string, flags: Flags): Promise<void> {
  const mcp = await import('@ai-application-toolkit/mcp').catch(() =>
    fail('serve requires the optional dependency "@ai-application-toolkit/mcp" (npm i @ai-application-toolkit/mcp)')
  )

  const graph = await buildCodeGraph(buildOptions(dir, flags))
  console.log(`Indexed ${graph.files().length} files, ${graph.symbols().length} symbols.`)

  const capability = defineCodegraphCapability(graph)
  const port = flags.port ?? 3000
  const path = flags.path ?? '/mcp'

  const server = await mcp.startHttpMcpServer({
    name: 'codegraph-mcp',
    version: await readVersion(),
    tools: collectCapabilityTools([capability]),
    port,
    path
  })

  const localUrl = `http://localhost:${port}${path}`
  console.log(`\nMCP server listening on ${localUrl}`)
  console.log('Tools: ' + capability.tools.map((t) => t.id).join(', '))

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
    if (tunnel) await tunnel.close().catch(() => {})
    server.close()
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
  if (command !== 'build' && command !== 'serve') fail(`Unknown command: ${command}`)
  if (!dirArg) fail(`${command} requires a <dir> argument`)
  const dir = resolve(process.cwd(), dirArg)

  if (command === 'build') await cmdBuild(dir, flags)
  else await cmdServe(dir, flags)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
