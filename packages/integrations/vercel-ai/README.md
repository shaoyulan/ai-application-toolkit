# @ai-application-toolkit/vercel-ai

Use AI Application Toolkit tools with the Vercel AI SDK.

Part of the [AI Application Toolkit](https://github.com/shaoyulan/ai-application-toolkit#readme).

## Install

```bash
pnpm add @ai-application-toolkit/vercel-ai ai
```

## Usage

`toVercelTools` converts toolkit tools into a Vercel AI SDK `ToolSet`. Each
tool's JSON Schema becomes the AI SDK `inputSchema`, and `execute` runs through
the toolkit runtime — so input validation, guardrails, context, and tracing all
apply.

```ts
import { generateText } from 'ai'
import { openai } from '@ai-sdk/openai'
import { defineTool } from '@ai-application-toolkit/tool'
import { toVercelTools } from '@ai-application-toolkit/vercel-ai'

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
  prompt: 'What is 2 + 3?',
  tools: toVercelTools([add])
})
```

Pass `runtime` to add guardrails, a base context, a trace sink, or a timeout:

```ts
toVercelTools([add], { runtime: { guardrails: [myGuardrail], timeoutMs: 5000 } })
```

## License

MIT © Danny LAN
