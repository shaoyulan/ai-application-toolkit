import { defineTool } from '@ai-application-toolkit/tool'
import { defineGuardrail } from '@ai-application-toolkit/guardrail'
import { createMemoryTraceSink } from '@ai-application-toolkit/trace'
import { createRuntime } from '@ai-application-toolkit/runtime'

// A tool that reads the immutable run context the runtime passes in.
const greet = defineTool({
  id: 'greet',
  execute: (input: { name: string }, context) => {
    const tenant = context?.data.variables?.tenant ?? 'unknown'
    return { message: `Hello ${input.name} (tenant: ${tenant})` }
  }
})

// A guardrail runs as middleware before every tool execution.
const noEmptyName = defineGuardrail<{ name: string }>({
  id: 'no-empty-name',
  check: (input) =>
    input.name.trim().length > 0
      ? { allowed: true }
      : { allowed: false, reason: 'name must not be empty' }
})

const trace = createMemoryTraceSink()

const runtime = createRuntime({
  tools: [greet],
  guardrails: [noEmptyName],
  context: { variables: { tenant: 'acme' } },
  trace
})

const result = await runtime.executeTool({
  toolId: 'greet',
  input: { name: 'Ada' }
})

console.log(result)
console.log('trace:', trace.events.map((e) => e.type).join(' -> '))
