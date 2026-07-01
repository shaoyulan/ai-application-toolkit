import type { Awaitable, ToolkitContextData } from '@ai-application-toolkit/core'

export interface GuardrailResult {
  allowed: boolean
  reason?: string
}

/**
 * Read-only context the runtime passes to a guardrail alongside the input. It
 * exposes the tool being invoked and the immutable run context, which lets
 * guardrails make decisions based on caller identity (`data.metadata.auth`),
 * the target tool, and cancellation — not just the raw input.
 */
export interface GuardrailContext {
  toolId: string
  data: Readonly<ToolkitContextData>
  signal?: AbortSignal
}

export interface Guardrail<TInput = unknown> {
  id: string
  /**
   * Returns whether the input is allowed. The runtime supplies `ctx` so the
   * guardrail can inspect the target tool and run context; older guardrails
   * that ignore the second argument keep working unchanged.
   */
  check(input: TInput, ctx?: GuardrailContext): Awaitable<GuardrailResult>
}

export function defineGuardrail<TInput>(guardrail: Guardrail<TInput>): Guardrail<TInput> {
  return Object.freeze(guardrail)
}

/**
 * Authorization guardrail: each tool may require a set of OAuth scopes, checked
 * against the authenticated caller's scopes in `ctx.data.metadata.auth.scopes`.
 * A tool with no entry in `required` is allowed. Implemented as a guardrail so
 * it runs through the standard runtime middleware (AGENTS.md rule 7) and a
 * denial surfaces as the usual `GUARDRAIL_BLOCKED` error.
 *
 * @example
 * const authz = defineScopeGuardrail({
 *   id: 'scopes',
 *   required: { 'delete-user': ['admin'] }
 * })
 * createRuntime({ tools, guardrails: [authz] })
 */
export function defineScopeGuardrail(options: {
  id?: string
  required: Record<string, string[]>
}): Guardrail {
  const { id = 'scope-authorization', required } = options
  return defineGuardrail({
    id,
    check(_input, ctx) {
      const need = ctx ? required[ctx.toolId] : undefined
      if (!need || need.length === 0) {
        return { allowed: true }
      }
      const have = new Set(ctx?.data.metadata?.auth?.scopes ?? [])
      const missing = need.filter((scope) => !have.has(scope))
      if (missing.length === 0) {
        return { allowed: true }
      }
      return { allowed: false, reason: `missing scope(s): ${missing.join(', ')}` }
    }
  })
}
