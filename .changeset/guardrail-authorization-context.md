---
"@ai-application-toolkit/core": minor
"@ai-application-toolkit/guardrail": minor
"@ai-application-toolkit/runtime": minor
---

Guardrails can now authorize, not just validate. `Guardrail.check` receives an
optional `GuardrailContext` (the target tool id and the immutable run context)
as a second argument, and the runtime supplies it on every check. A new
`defineScopeGuardrail` factory enforces per-tool OAuth scope requirements
against the authenticated caller in `context.metadata.auth`. Existing
guardrails that ignore the second argument are unaffected.
