import { connectMcpClient } from '@ai-application-toolkit/mcp'
import { createRuntime } from '@ai-application-toolkit/runtime'
import { createAnthropicAdapter } from '@ai-application-toolkit/anthropic'

// A minimal "design → code" pipeline: pull the selected frame's design context
// from the Figma MCP server (through the toolkit runtime), then ask Claude to
// turn it into a React component. The runtime governs the Figma calls; the
// Anthropic adapter does the generation. Select a frame in Figma first.
const figma = await connectMcpClient({
  transport: { kind: 'http', url: 'http://127.0.0.1:3845/mcp' },
  toolIdPrefix: 'figma.'
})

const runtime = createRuntime({ tools: figma.tools, timeoutMs: 30_000 })
const claude = createAnthropicAdapter() // reads ANTHROPIC_API_KEY

// 1. Fetch structured design context (and tokens) for the current selection.
const [context, tokens] = await Promise.all([
  runtime.executeTool({ toolId: 'figma.get_design_context', input: {} }),
  runtime.executeTool({ toolId: 'figma.get_variable_defs', input: {} })
])

// 2. Hand it to Claude to generate a component.
const result = await claude.generate({
  system:
    'You are a senior frontend engineer. Produce a single, self-contained React + TypeScript ' +
    'component using the provided design tokens. Return only code, no prose.',
  prompt: [
    'Design context (from Figma):',
    '```json',
    JSON.stringify(context, null, 2),
    '```',
    '',
    'Design tokens:',
    '```json',
    JSON.stringify(tokens, null, 2),
    '```',
    '',
    'Generate the matching React component.'
  ].join('\n')
})

console.log(result.text)
console.log(`\n[${result.model}] tokens out=${result.usage.outputTokens}`)

await figma.close()
