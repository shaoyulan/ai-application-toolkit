import Anthropic from '@anthropic-ai/sdk'

/** Default model — the most capable Claude model. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8'

/**
 * Non-streaming default. Kept under ~16K so requests stay below the SDK's
 * HTTP timeout without needing to stream.
 */
export const DEFAULT_MAX_TOKENS = 16000

export interface AnthropicAdapterOptions {
  /** Falls back to the `ANTHROPIC_API_KEY` environment variable. */
  apiKey?: string
  /** Model id. Defaults to {@link DEFAULT_ANTHROPIC_MODEL}. */
  model?: string
  /** Default `max_tokens` for generations. Defaults to {@link DEFAULT_MAX_TOKENS}. */
  maxTokens?: number
  /**
   * Pre-constructed Anthropic client. Mainly useful for injecting a fake in
   * tests; when omitted a client is created lazily from `apiKey`.
   */
  client?: Pick<Anthropic, 'messages'>
}

export interface GenerateInput {
  prompt: string
  /** Optional system prompt. */
  system?: string
  /** Overrides the adapter's default `max_tokens` for this call. */
  maxTokens?: number
}

export interface GenerateUsage {
  inputTokens: number
  outputTokens: number
}

export interface GenerateResult {
  text: string
  model: string
  stopReason: string | null
  usage: GenerateUsage
}

export interface AnthropicAdapter {
  readonly provider: 'anthropic'
  readonly model: string
  generate(input: GenerateInput): Promise<GenerateResult>
}

export function createAnthropicAdapter(
  options: AnthropicAdapterOptions = {}
): AnthropicAdapter {
  const model = options.model ?? DEFAULT_ANTHROPIC_MODEL
  const defaultMaxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS

  let client = options.client

  function getClient(): Pick<Anthropic, 'messages'> {
    if (client) {
      return client
    }

    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY

    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY is required (pass options.apiKey or set the environment variable)'
      )
    }

    client = new Anthropic({ apiKey })
    return client
  }

  return {
    provider: 'anthropic',
    model,
    async generate(input: GenerateInput): Promise<GenerateResult> {
      const response = await getClient().messages.create({
        model,
        max_tokens: input.maxTokens ?? defaultMaxTokens,
        // Adaptive thinking: let Claude decide how much to reason per request.
        thinking: { type: 'adaptive' },
        ...(input.system ? { system: input.system } : {}),
        messages: [{ role: 'user', content: input.prompt }]
      })

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('')

      return {
        text,
        model: response.model,
        stopReason: response.stop_reason,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens
        }
      }
    }
  }
}
