export interface OpenAIAdapterOptions {
  apiKey?: string
  model: string
}

export function createOpenAIAdapter(options: OpenAIAdapterOptions) {
  return {
    provider: 'openai' as const,
    model: options.model,
    async generate(input: { prompt: string }) {
      if (!options.apiKey) {
        throw new Error('OPENAI_API_KEY is required')
      }

      // Intentionally minimal placeholder.
      // Real implementation should call the official OpenAI SDK.
      return {
        text: `Generated response for: ${input.prompt}`
      }
    }
  }
}
