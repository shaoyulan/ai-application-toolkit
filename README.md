# AI Application Toolkit

A composable, provider-agnostic toolkit for building AI applications.

This repository is designed as a production-ready open-source monorepo:
- npm packages under `packages/`
- Nuxt documentation site under `apps/docs`
- release automation with Changesets
- GitHub Actions for CI and release
- AI-agent-readable architecture rules via `AGENTS.md`

## Core idea

AI applications should be built from small composable primitives:

```txt
Tool -> Runtime -> Context -> Capability -> Workflow -> Adapter -> Provider
```

## Quick start

```bash
pnpm install
pnpm build
pnpm dev:docs
```

## Packages

- `@ai-application-toolkit/core`
- `@ai-application-toolkit/runtime`
- `@ai-application-toolkit/tool`
- `@ai-application-toolkit/context`
- `@ai-application-toolkit/capability`
- `@ai-application-toolkit/workflow`
- `@ai-application-toolkit/guardrail`
- `@ai-application-toolkit/trace`
- `@ai-application-toolkit/openai`

## Release

```bash
pnpm changeset
pnpm version-packages
pnpm release
```

## Documentation

The docs site is a Nuxt 3 + Nuxt Content app:

```bash
pnpm dev:docs
```

Deploy target: Vercel.
