import { createOpenAIAdapter } from '@ai-application-toolkit/openai'

// Reads OPENAI_API_KEY from the environment. `model` is required.
const openai = createOpenAIAdapter({ model: 'gpt-4o' })

const result = await openai.generate({
  system: 'You are a concise assistant.',
  prompt: 'In one sentence, what is a composable AI toolkit?'
})

console.log(result.text)
console.log(`[${result.model}] finish=${result.finishReason} tokens=${result.usage.outputTokens}`)
