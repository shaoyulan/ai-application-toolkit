# @ai-application-toolkit/guardrail

Guardrail middleware for the AI Application Toolkit runtime.

Part of the [AI Application Toolkit](https://github.com/shaoyulan/ai-application-toolkit#readme).

## Install

```bash
pnpm add @ai-application-toolkit/guardrail
```

## Usage

A guardrail returns whether an input is allowed. The runtime runs every
guardrail before executing a tool and passes a `GuardrailContext` (the target
tool id and the immutable run context) as the second argument, so guardrails can
authorize based on the caller — not just the raw input.

```ts
import { defineGuardrail } from '@ai-application-toolkit/guardrail'

const noSecrets = defineGuardrail<{ text: string }>({
  id: 'no-secrets',
  check: ({ text }) =>
    text.includes('SECRET') ? { allowed: false, reason: 'contains secret' } : { allowed: true }
})
```

### Scope-based authorization

`defineScopeGuardrail` enforces per-tool OAuth scopes against the authenticated
caller in `context.metadata.auth.scopes` (populated by a transport boundary such
as the MCP HTTP server). A tool with no entry is unrestricted.

```ts
import { defineScopeGuardrail } from '@ai-application-toolkit/guardrail'

const authz = defineScopeGuardrail({
  required: { 'delete-user': ['admin'] }
})

createRuntime({ tools, guardrails: [authz] })
```

## License

MIT © Danny LAN
