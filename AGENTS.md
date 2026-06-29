# AGENTS.md

This file is the source of truth for AI coding agents working in this repository.

## Non-negotiable architecture rules

1. Never call a model provider directly from application code.
2. Always access AI providers through an Adapter.
3. Always define external actions as Tools.
4. Runtime executes Tools; Tools must not execute Runtime.
5. Context is immutable during one execution run.
6. Workflow orchestrates Runtime; Runtime must not know Workflow.
7. Guardrails must be implemented as middleware.
8. Every Runtime execution must emit trace events.
9. Packages must remain independently installable.
10. Do not introduce cross-package imports that violate dependency rules.

## Dependency direction

Allowed high-level direction:

```txt
utils <- core <- tool <- runtime <- workflow
                 context <- capability
                 trace <- runtime
                 guardrail <- runtime
providers -> adapter -> core
```

## Coding style

- TypeScript strict mode.
- No `any` unless explicitly justified.
- Prefer small pure functions.
- Prefer composition over inheritance.
- Public APIs must include examples in docs.
- Every package needs build, test, and typecheck scripts.

## When generating code

Before adding a new feature:
1. identify the layer it belongs to;
2. check dependency rules;
3. add or update docs;
4. add at least one test;
5. add a changeset for public API changes.
