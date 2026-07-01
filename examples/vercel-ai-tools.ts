import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'
import { defineTool } from '@ai-application-toolkit/tool'
import { toVercelTools } from '@ai-application-toolkit/vercel-ai'

// Define toolkit tools once; toVercelTools turns them into AI SDK tools whose
// execute routes through the runtime (validation, guardrails, tracing).
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

const result = await generateText({
  model: openai('gpt-4o'),
  prompt: 'What is 2 + 3? Use the add tool.',
  tools: toVercelTools([add])
})

console.log(result.text)
