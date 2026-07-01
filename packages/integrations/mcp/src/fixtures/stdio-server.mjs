// A minimal stdio MCP server used only by client.test.ts to exercise the
// stdio transport branch of connectMcpClient. It exposes two tools:
//  - `echo`: has a description + inputSchema, returns a single text block.
//  - `bare`: no description, no meaningful inputSchema, returns two text
//    blocks so the client's multi-block content mapping path is exercised.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  { name: 'stdio-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echoes its message back',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message']
      }
    },
    // No description; a bare object schema so the wrapped tool still works but
    // carries no meaningful input contract.
    { name: 'bare', inputSchema: { type: 'object', properties: {} } }
  ]
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  if (name === 'echo') {
    return { content: [{ type: 'text', text: String(args?.message ?? '') }] }
  }
  // Two blocks -> exercises the multi-block branch of fromMcpContent.
  return {
    content: [
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' }
    ]
  }
})

await server.connect(new StdioServerTransport())
