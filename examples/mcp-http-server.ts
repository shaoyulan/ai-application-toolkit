import { defineTool } from '@ai-application-toolkit/tool'
import { startHttpMcpServer } from '@ai-application-toolkit/mcp'

// Serving toolkit tools over the MCP Streamable HTTP transport. This is the
// remote alternative to stdio — point a Streamable HTTP MCP client at the URL.
// It runs stateless by default (no session bound to the connection), so it can
// scale horizontally behind a load balancer.
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

await startHttpMcpServer({
  name: 'ai-toolkit-http-example',
  version: '1.0.0',
  tools: [add],
  port: 3000
})

console.log('MCP server listening on http://localhost:3000/mcp')
