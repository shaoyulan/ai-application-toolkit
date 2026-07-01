import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpenAIAdapter } from './index'

const { openaiCtor } = vi.hoisted(() => ({ openaiCtor: vi.fn() }))

vi.mock('openai', () => ({
  default: class {
    chat: unknown
    constructor(config: unknown) {
      openaiCtor(config)
      this.chat = {
        completions: {
          create: async () => ({
            model: 'gpt-4o',
            choices: [{ message: { content: 'from real client' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 2 }
          })
        }
      }
    }
  }
}))

function fakeClient(create: (params: any) => Promise<any>) {
  return { chat: { completions: { create } } } as any
}

function fakeCompletion(overrides: Record<string, unknown> = {}) {
  return {
    model: 'gpt-4o',
    choices: [{ message: { content: 'Hello world' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
    ...overrides
  }
}

describe('createOpenAIAdapter', () => {
  afterEach(() => openaiCtor.mockClear())

  it('exposes provider and model', () => {
    const adapter = createOpenAIAdapter({
      model: 'gpt-4o',
      client: fakeClient(async () => fakeCompletion())
    })
    expect(adapter.provider).toBe('openai')
    expect(adapter.model).toBe('gpt-4o')
  })

  it('returns text, model, finishReason and usage', async () => {
    const adapter = createOpenAIAdapter({
      model: 'gpt-4o',
      client: fakeClient(async () => fakeCompletion())
    })
    const result = await adapter.generate({ prompt: 'hi' })

    expect(result.text).toBe('Hello world')
    expect(result.model).toBe('gpt-4o')
    expect(result.finishReason).toBe('stop')
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 })
  })

  it('includes a system message and passes max_tokens', async () => {
    const create = vi.fn(async (_params: any) => fakeCompletion())
    const adapter = createOpenAIAdapter({ model: 'gpt-4o', client: fakeClient(create) })

    await adapter.generate({ prompt: 'hi', system: 'be terse', maxTokens: 256 })

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-4o',
        max_tokens: 256,
        messages: [
          { role: 'system', content: 'be terse' },
          { role: 'user', content: 'hi' }
        ]
      })
    )
  })

  it('omits max_tokens when none is configured', async () => {
    const create = vi.fn(async (_params: any) => fakeCompletion())
    const adapter = createOpenAIAdapter({ model: 'gpt-4o', client: fakeClient(create) })

    await adapter.generate({ prompt: 'hi' })

    expect(create.mock.calls[0][0]).not.toHaveProperty('max_tokens')
  })

  it('handles a null message content gracefully', async () => {
    const adapter = createOpenAIAdapter({
      model: 'gpt-4o',
      client: fakeClient(async () =>
        fakeCompletion({ choices: [{ message: { content: null }, finish_reason: 'length' }] })
      )
    })
    const result = await adapter.generate({ prompt: 'hi' })
    expect(result.text).toBe('')
    expect(result.finishReason).toBe('length')
  })

  it('sends no system message when none is provided', async () => {
    const create = vi.fn(async (_params: any) => fakeCompletion())
    const adapter = createOpenAIAdapter({ model: 'gpt-4o', client: fakeClient(create) })

    await adapter.generate({ prompt: 'hi' })

    expect(create.mock.calls[0][0].messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('defaults finishReason to null and usage to zeros when the response omits them', async () => {
    const adapter = createOpenAIAdapter({
      model: 'gpt-4o',
      client: fakeClient(async () => ({
        model: 'gpt-4o',
        choices: [{ message: { content: 'ok' } }]
      }))
    })
    const result = await adapter.generate({ prompt: 'hi' })

    expect(result.finishReason).toBeNull()
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('constructs a real OpenAI client from options.apiKey when no client is injected', async () => {
    const adapter = createOpenAIAdapter({ model: 'gpt-4o', apiKey: 'sk-test' })
    const result = await adapter.generate({ prompt: 'hi' })

    expect(openaiCtor).toHaveBeenCalledWith({ apiKey: 'sk-test' })
    expect(result.text).toBe('from real client')
  })

  it('constructs a real OpenAI client from the OPENAI_API_KEY env var', async () => {
    const previous = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'sk-env'
    try {
      const adapter = createOpenAIAdapter({ model: 'gpt-4o' })
      await adapter.generate({ prompt: 'hi' })
      expect(openaiCtor).toHaveBeenCalledWith({ apiKey: 'sk-env' })
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previous
    }
  })

  it('throws a clear error when no api key or client is available', () => {
    const previous = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    try {
      const adapter = createOpenAIAdapter({ model: 'gpt-4o' })
      return expect(adapter.generate({ prompt: 'hi' })).rejects.toThrow(/OPENAI_API_KEY is required/)
    } finally {
      if (previous !== undefined) {
        process.env.OPENAI_API_KEY = previous
      }
    }
  })
})
