import { describe, expect, it } from 'vitest'
import { defineGuardrail, defineScopeGuardrail, type GuardrailContext } from './index'

const ctx = (toolId: string, scopes?: string[]): GuardrailContext => ({
  toolId,
  data: { metadata: { auth: { scopes } } }
})

describe('defineGuardrail', () => {
  it('freezes the guardrail', () => {
    const guardrail = defineGuardrail({ id: 'g', check: () => ({ allowed: true }) })
    expect(Object.isFrozen(guardrail)).toBe(true)
  })

  it('runs the check and returns its result', async () => {
    const guardrail = defineGuardrail<string>({
      id: 'no-secrets',
      check: (input) =>
        input.includes('secret')
          ? { allowed: false, reason: 'contains secret' }
          : { allowed: true }
    })

    expect(await guardrail.check('hello')).toEqual({ allowed: true })
    expect(await guardrail.check('my secret')).toEqual({
      allowed: false,
      reason: 'contains secret'
    })
  })

  it('receives the run context as the second argument', async () => {
    let seen: GuardrailContext | undefined
    const guardrail = defineGuardrail({
      id: 'spy',
      check: (_input, c) => {
        seen = c
        return { allowed: true }
      }
    })
    await guardrail.check({}, ctx('greet', ['read']))
    expect(seen?.toolId).toBe('greet')
    expect(seen?.data.metadata?.auth?.scopes).toEqual(['read'])
  })
})

describe('defineScopeGuardrail', () => {
  const authz = defineScopeGuardrail({ required: { 'delete-user': ['admin'] } })

  it('allows tools with no scope requirement', async () => {
    expect(await authz.check({}, ctx('greet'))).toEqual({ allowed: true })
  })

  it('allows when the caller has all required scopes', async () => {
    expect(await authz.check({}, ctx('delete-user', ['admin', 'read']))).toEqual({
      allowed: true
    })
  })

  it('blocks and names the missing scope when the caller lacks it', async () => {
    const result = await authz.check({}, ctx('delete-user', ['read']))
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('admin')
  })

  it('blocks when there is no auth context at all', async () => {
    expect((await authz.check({}, ctx('delete-user'))).allowed).toBe(false)
  })
})
