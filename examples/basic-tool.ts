import { defineTool } from '@ai-application-toolkit/tool'
import { createRuntime } from '@ai-application-toolkit/runtime'

const helloTool = defineTool({
  id: 'hello',
  input: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false
  },
  execute: async (input: { name: string }) => {
    return { message: `Hello, ${input.name}` }
  }
})

const runtime = createRuntime({
  tools: [helloTool]
})

const result = await runtime.executeTool({
  toolId: 'hello',
  input: { name: 'AI Toolkit' }
})

console.log(result)
