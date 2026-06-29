export interface GuardrailResult {
  allowed: boolean
  reason?: string
}

export interface Guardrail<TInput = unknown> {
  id: string
  check(input: TInput): Promise<GuardrailResult> | GuardrailResult
}

export function defineGuardrail<TInput>(guardrail: Guardrail<TInput>): Guardrail<TInput> {
  return Object.freeze(guardrail)
}
