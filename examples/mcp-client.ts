import { connectMcpClient } from '@ai-application-toolkit/mcp'
import { createRuntime } from '@ai-application-toolkit/runtime'
import { defineGuardrail } from '@ai-application-toolkit/guardrail'

// Consuming an external MCP server. connectMcpClient lists the server's tools
// and wraps each as a toolkit tool, so running them through the runtime applies
// the same input validation, guardrails, timeout, and tracing as local tools —
// i.e. it puts any MCP server under your governance layer.
const remote = await connectMcpClient({
  // stdio launches a local server process; use { kind: 'http', url } for remote.
  transport: { kind: 'stdio', command: 'some-mcp-server', args: [] },
  toolIdPrefix: 'remote.'
})

const auditLog = defineGuardrail({
  id: 'audit',
  check: (input) => {
    console.log('tool call:', JSON.stringify(input))
    return { allowed: true }
  }
})

const runtime = createRuntime({ tools: remote.tools, guardrails: [auditLog] })

console.log(
  'Available remote tools:',
  remote.tools.map((t) => t.id)
)

// Example: invoke one of the wrapped remote tools through the runtime.
// const result = await runtime.executeTool({ toolId: 'remote.search', input: { q: 'hello' } })
// console.log(result)

await remote.close()
