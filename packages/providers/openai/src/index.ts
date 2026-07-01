import OpenAI from 'openai'

export interface OpenAIAdapterOptions {
  /** Falls back to the `OPENAI_API_KEY` environment variable. */
  apiKey?: string
  /** Model id, e.g. `gpt-4o`. Required — no default is assumed. */
  model: string
  /** Default `max_tokens` for generations. Omitted from the request if unset. */
  maxTokens?: number
  /**
   * Pre-constructed OpenAI client. Mainly useful for injecting a fake in tests;
   * when omitted a client is created lazily from `apiKey`.
   */
  client?: Pick<OpenAI, 'chat'>
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
  finishReason: string | null
  usage: GenerateUsage
}

export interface OpenAIAdapter {
  readonly provider: 'openai'
  readonly model: string
  generate(input: GenerateInput): Promise<GenerateResult>
}

export function createOpenAIAdapter(options: OpenAIAdapterOptions): OpenAIAdapter {
  const model = options.model

  let client = options.client

  function getClient(): Pick<OpenAI, 'chat'> {
    if (client) {
      return client
    }

    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY

    if (!apiKey) {
      throw new Error(
        'OPENAI_API_KEY is required (pass options.apiKey or set the environment variable)'
      )
    }

    client = new OpenAI({ apiKey })
    return client
  }

  return {
    provider: 'openai',
    model,
    async generate(input: GenerateInput): Promise<GenerateResult> {
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = []
      if (input.system) {
        messages.push({ role: 'system', content: input.system })
      }
      messages.push({ role: 'user', content: input.prompt })

      const maxTokens = input.maxTokens ?? options.maxTokens

      const response = await getClient().chat.completions.create({
        model,
        messages,
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {})
      })

      const choice = response.choices[0]

      return {
        text: choice?.message?.content ?? '',
        model: response.model,
        finishReason: choice?.finish_reason ?? null,
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0
        }
      }
    }
  }
}
