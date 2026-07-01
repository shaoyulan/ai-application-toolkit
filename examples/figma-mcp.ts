import { connectMcpClient } from '@ai-application-toolkit/mcp'
import { createRuntime } from '@ai-application-toolkit/runtime'
import { defineGuardrail } from '@ai-application-toolkit/guardrail'
import { createMemoryTraceSink } from '@ai-application-toolkit/trace'

// Consume the Figma Desktop Dev Mode MCP server as toolkit tools. Because they
// run through the runtime, every Figma call gets the same governance as your
// own tools: input validation, guardrails, a timeout, and trace events.
const figma = await connectMcpClient({
  transport: { kind: 'http', url: 'http://127.0.0.1:3845/mcp' },
  toolIdPrefix: 'figma.'
})

// Audit every call; the trace sink records start/end/error for each execution.
const audit = defineGuardrail({
  id: 'audit',
  check: (input) => {
    console.log('→ figma call:', JSON.stringify(input))
    return { allowed: true }
  }
})
const trace = createMemoryTraceSink()

const runtime = createRuntime({
  tools: figma.tools,
  guardrails: [audit],
  trace,
  timeoutMs: 30_000
})

// What does this Figma MCP server expose?
console.log(
  'Available Figma tools:',
  figma.tools.map((t) => t.id)
)

// These tools operate on the current selection in Figma. Select a frame or
// component in Figma Desktop first, otherwise the server returns "Nothing is
// selected" (surfaced here as a TOOL_EXECUTION_FAILED). Pass { nodeId } to
// target a specific node instead of the selection.
try {
  // Design tokens (colors, spacing, type scale).
  const tokens = await runtime.executeTool({ toolId: 'figma.get_variable_defs', input: {} })
  console.log('Design tokens:\n', tokens)

  // Structured design context — the basis for codegen.
  const context = await runtime.executeTool({ toolId: 'figma.get_design_context', input: {} })
  console.log('Design context:\n', context)
} catch (error) {
  console.error('Could not read the selection — is a frame selected in Figma?')
  console.error(error instanceof Error ? error.message : error)
}

console.log('\nTrace events:', trace.events.map((e) => e.type))

await figma.close()
