# @ai-application-toolkit/mcp

Connect the AI Application Toolkit to the Model Context Protocol — **serve** your
tools to MCP clients (over stdio or remote HTTP), or **consume** any external MCP
server's tools as toolkit tools.

Part of the [AI Application Toolkit](https://github.com/shaoyulan/ai-application-toolkit#readme).

## Install

```bash
pnpm add @ai-application-toolkit/mcp @modelcontextprotocol/sdk
```

## Usage

Define tools once, then serve them over MCP. Tool input schemas are forwarded
as MCP `inputSchema`, and `tools/call` runs through the toolkit runtime — so
input validation, guardrails, context, and tracing all apply.

```ts
import { defineTool } from '@ai-application-toolkit/tool'
import { startStdioMcpServer } from '@ai-application-toolkit/mcp'

const add = defineTool({
  id: 'add',
  description: 'Add two numbers',
  input: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
    additionalProperties: false
  },
  execute: (input: { a: number; b: number }) => input.a + input.b
})

await startStdioMcpServer({ name: 'my-tools', version: '1.0.0', tools: [add] })
```

Use `createMcpServer(...)` if you want to connect a transport yourself, and pass
`runtime` to add guardrails, a base context, a trace sink, or a timeout:

```ts
import { createMcpServer } from '@ai-application-toolkit/mcp'

const server = createMcpServer({
  name: 'my-tools',
  version: '1.0.0',
  tools: [add],
  runtime: { guardrails: [myGuardrail], timeoutMs: 5000 }
})
```

### Serve over HTTP (remote, stateless)

`startHttpMcpServer` serves the same tools over the MCP Streamable HTTP
transport. It is **stateless by default** (no session bound to the connection),
so it scales horizontally behind a load balancer. `createHttpMcpHandler` returns
a framework-agnostic Node `(req, res)` handler you can mount anywhere.

```ts
import { startHttpMcpServer } from '@ai-application-toolkit/mcp'

await startHttpMcpServer({ name: 'my-tools', version: '1.0.0', tools: [add], port: 3000 })
// Point a Streamable HTTP MCP client at http://localhost:3000/mcp
```

### Protect it with OAuth 2.1 + scopes

Verify a bearer JWT at the transport boundary with `createBearerVerifier` (JWKS),
then authorize per tool with `defineScopeGuardrail`. The verified caller is
placed on `context.metadata.auth`, where the scope guardrail reads it.

```ts
import { startHttpMcpServer, createBearerVerifier } from '@ai-application-toolkit/mcp'
import { defineScopeGuardrail } from '@ai-application-toolkit/guardrail'

await startHttpMcpServer({
  name: 'my-tools',
  version: '1.0.0',
  tools: [add],
  port: 3000,
  authenticate: createBearerVerifier({
    jwksUri: 'https://issuer.example.com/.well-known/jwks.json',
    issuer: 'https://issuer.example.com/',
    audience: 'https://my-mcp-server.example.com'
  }),
  resourceMetadataUrl: 'https://my-mcp-server.example.com/.well-known/oauth-protected-resource',
  runtime: { guardrails: [defineScopeGuardrail({ required: { add: ['calc:write'] } })] }
})
```

Unauthenticated requests get `401` with a `WWW-Authenticate` challenge; callers
missing a required scope get the usual `GUARDRAIL_BLOCKED` tool error.

## Consume an external MCP server (client)

`connectMcpClient` connects to any MCP server and wraps its tools as toolkit
tools, so they run through your runtime — picking up the same input validation,
guardrails, timeout, and tracing as local tools.

```ts
import { connectMcpClient } from '@ai-application-toolkit/mcp'
import { createRuntime } from '@ai-application-toolkit/runtime'

const remote = await connectMcpClient({
  transport: { kind: 'stdio', command: 'some-mcp-server' }, // or { kind: 'http', url }
  toolIdPrefix: 'remote.'
})

const runtime = createRuntime({ tools: remote.tools, guardrails: [myGuardrail] })
await runtime.executeTool({ toolId: 'remote.search', input: { q: 'hello' } })

await remote.close()
```

## License

MIT © Danny LAN
