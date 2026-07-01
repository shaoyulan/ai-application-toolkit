/**
 * Serve a code graph as an MCP server over Streamable HTTP.
 *
 * Builds the graph once at startup, exposes its query tools
 * (codegraph_search_symbols, codegraph_relevant_context, …) and serves them on
 * the MCP Streamable HTTP transport — so any MCP client (Claude Desktop, the
 * MCP Inspector, or another agent) can explore the codebase remotely.
 *
 * Usage:
 *   pnpm --filter @ai-application-toolkit/examples codegraph-mcp-http [dir] [port]
 *
 *   # then, in another terminal, point a client at it:
 *   npx @modelcontextprotocol/inspector            # GUI, connect to the URL below
 *
 * Stateless by default, so it scales horizontally behind a load balancer.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectCapabilityTools } from '@ai-application-toolkit/capability'
import { buildCodeGraph, defineCodegraphCapability } from '@ai-application-toolkit/codegraph'
import { startHttpMcpServer } from '@ai-application-toolkit/mcp'

const DEFAULT_DIR = fileURLToPath(new URL('../packages', import.meta.url))

// `pnpm --filter` runs in the package dir, so resolve a relative `[dir]` arg
// against the directory the user actually invoked the command from (INIT_CWD).
const invokedFrom = process.env.INIT_CWD ?? process.cwd()
const dir = process.argv[2] ? resolve(invokedFrom, process.argv[2]) : DEFAULT_DIR
const port = Number(process.argv[3] ?? 3000)
const path = '/mcp'

console.log(`Building code graph for ${dir} …`)
const graph = await buildCodeGraph({ dir })
console.log(`Indexed ${graph.files().length} files, ${graph.symbols().length} symbols.`)

const codegraph = defineCodegraphCapability(graph)

await startHttpMcpServer({
  name: 'codegraph-mcp',
  version: '1.0.0',
  tools: collectCapabilityTools([codegraph]),
  port,
  path
})

const url = `http://localhost:${port}${path}`
console.log(`\nMCP server listening on ${url}`)
console.log('Tools exposed:')
for (const tool of codegraph.tools) console.log(`  - ${tool.id}`)

// Optionally expose a public URL via untun (Cloudflare quick tunnel).
// Pass --tunnel as the last argument. untun is an optional dependency.
if (process.argv.includes('--tunnel')) {
  const { startTunnel } = await import('untun')
  console.log('\nStarting tunnel via untun (Cloudflare)…')
  const tunnel = await startTunnel({ port, hostname: 'localhost' })
  console.log(`Public URL: ${(await tunnel?.getURL()) ?? '(unavailable)'}${path}`)
}

console.log('\nConnect from the same repo with the toolkit MCP client:')
console.log(`
  import { connectMcpClient } from '@ai-application-toolkit/mcp'
  const client = await connectMcpClient({ transport: { kind: 'http', url: '${url}' } })
  const tools = await client.listTools()           // codegraph_* tools, ready for createRuntime
`)
