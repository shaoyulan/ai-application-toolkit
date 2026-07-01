import { describe, expect, it, vi } from 'vitest'
import { createOpenAIAdapter } from './index'

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
