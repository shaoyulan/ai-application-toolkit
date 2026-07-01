# @ai-application-toolkit/runtime

## 0.1.0

### Minor Changes

- ef4faa4: Guardrails can now authorize, not just validate. `Guardrail.check` receives an
  optional `GuardrailContext` (the target tool id and the immutable run context)
  as a second argument, and the runtime supplies it on every check. A new
  `defineScopeGuardrail` factory enforces per-tool OAuth scope requirements
  against the authenticated caller in `context.metadata.auth`. Existing
  guardrails that ignore the second argument are unaffected.
- b556a67: Initial public release of the AI Application Toolkit.

  Ships the core primitives (tool, runtime, context, capability, workflow,
  guardrail, trace, cache), provider adapters for Anthropic (Claude) and OpenAI,
  and integrations for the Model Context Protocol (expose tools as an MCP server)
  and the Vercel AI SDK (use tools with `generateText`/`streamText`).

### Patch Changes

- Updated dependencies [ef4faa4]
- Updated dependencies [ef4faa4]
- Updated dependencies [b556a67]
  - @ai-application-toolkit/tool@0.1.0
  - @ai-application-toolkit/core@0.1.0
  - @ai-application-toolkit/guardrail@0.1.0
  - @ai-application-toolkit/context@0.1.0
  - @ai-application-toolkit/trace@0.1.0
