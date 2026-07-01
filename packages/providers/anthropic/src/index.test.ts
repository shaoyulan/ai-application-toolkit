import { describe, expect, it, vi } from 'vitest'
import {
  createAnthropicAdapter,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_MAX_TOKENS
} from './index'

function fakeClient(create: (params: any) => Promise<any>) {
  return { messages: { create } } as any
}

function fakeMessage(overrides: Record<string, unknown> = {}) {
  return {
    model: 'claude-opus-4-8',
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 20 },
    content: [{ type: 'text', text: 'Hello world' }],
    ...overrides
  }
}

describe('createAnthropicAdapter', () => {
  it('exposes provider and default model', () => {
    const adapter = createAnthropicAdapter({ client: fakeClient(async () => fakeMessage()) })
    expect(adapter.provider).toBe('anthropic')
    expect(adapter.model).toBe(DEFAULT_ANTHROPIC_MODEL)
  })

  it('joins text blocks and surfaces model, usage and stopReason', async () => {
    const create = vi.fn(async (_params: any) =>
      fakeMessage({
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world' }
        ]
      })
    )
    const adapter = createAnthropicAdapter({ client: fakeClient(create) })

    const result = await adapter.generate({ prompt: 'hi' })

    expect(result.text).toBe('Hello world')
    expect(result.model).toBe('claude-opus-4-8')
    expect(result.stopReason).toBe('end_turn')
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 })
  })

  it('ignores non-text blocks (e.g. thinking)', async () => {
    const adapter = createAnthropicAdapter({
      client: fakeClient(async () =>
        fakeMessage({
          content: [
            { type: 'thinking', thinking: '' },
            { type: 'text', text: 'answer' }
          ]
        })
      )
    })

    const result = await adapter.generate({ prompt: 'hi' })
    expect(result.text).toBe('answer')
  })

  it('sends adaptive thinking and the chosen model/max_tokens', async () => {
    const create = vi.fn(async (_params: any) => fakeMessage())
    const adapter = createAnthropicAdapter({
      model: 'claude-sonnet-4-6',
      client: fakeClient(create)
    })

    await adapter.generate({ prompt: 'hi', system: 'be terse', maxTokens: 512 })

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        thinking: { type: 'adaptive' },
        system: 'be terse',
        messages: [{ role: 'user', content: 'hi' }]
      })
    )
  })

  it('falls back to the default max_tokens when none is given', async () => {
    const create = vi.fn(async (_params: any) => fakeMessage())
    const adapter = createAnthropicAdapter({ client: fakeClient(create) })

    await adapter.generate({ prompt: 'hi' })

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: DEFAULT_MAX_TOKENS })
    )
  })

  it('omits the system field when no system prompt is provided', async () => {
    const create = vi.fn(async (_params: any) => fakeMessage())
    const adapter = createAnthropicAdapter({ client: fakeClient(create) })

    await adapter.generate({ prompt: 'hi' })

    expect(create.mock.calls[0][0]).not.toHaveProperty('system')
  })

  it('throws a clear error when no api key or client is available', () => {
    const previous = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      const adapter = createAnthropicAdapter()
      // Client is created lazily on first generate().
      return expect(adapter.generate({ prompt: 'hi' })).rejects.toThrow(
        /ANTHROPIC_API_KEY is required/
      )
    } finally {
      if (previous !== undefined) {
        process.env.ANTHROPIC_API_KEY = previous
      }
    }
  })
})
