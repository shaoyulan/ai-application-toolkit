# @ai-application-toolkit/openai

OpenAI provider adapter for the AI Application Toolkit.

Part of the [AI Application Toolkit](https://github.com/shaoyulan/ai-application-toolkit#readme).

## Install

```bash
pnpm add @ai-application-toolkit/openai openai
```

## Usage

Reads `OPENAI_API_KEY` from the environment. `model` is required.

```ts
import { createOpenAIAdapter } from '@ai-application-toolkit/openai'

const openai = createOpenAIAdapter({ model: 'gpt-4o' })

const result = await openai.generate({
  system: 'You are a concise assistant.',
  prompt: 'In one sentence, what is a composable AI toolkit?'
})

console.log(result.text)
console.log(`[${result.model}] finish=${result.finishReason} tokens=${result.usage.outputTokens}`)
```

## License

MIT © Danny LAN
