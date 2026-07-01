import { createAnthropicAdapter } from '@ai-application-toolkit/anthropic'

// Reads ANTHROPIC_API_KEY from the environment. Defaults to claude-opus-4-8
// with adaptive thinking.
const claude = createAnthropicAdapter()

const result = await claude.generate({
  system: 'You are a concise assistant.',
  prompt: 'In one sentence, what is a composable AI toolkit?'
})

console.log(result.text)
console.log(`[${result.model}] stop=${result.stopReason} tokens=${result.usage.outputTokens}`)
