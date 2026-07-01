import { defineTool } from '@ai-application-toolkit/tool'
import { startStdioMcpServer } from '@ai-application-toolkit/mcp'

// Define toolkit tools as usual — the JSON Schema becomes the MCP inputSchema,
// and execution runs through the runtime (validation, guardrails, tracing).
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

// Serve over stdio — point an MCP client (Claude Desktop, Claude Code, …) at
// `node dist/mcp-server.js`.
await startStdioMcpServer({
  name: 'ai-toolkit-example',
  version: '1.0.0',
  tools: [add]
})
