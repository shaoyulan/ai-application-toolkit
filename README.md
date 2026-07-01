# AI Application Toolkit

A composable, provider-agnostic toolkit for building AI applications.

This repository is designed as a production-ready open-source monorepo:
- npm packages under `packages/`
- Mintlify documentation site under `apps/docs`
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

Published:

- `@ai-application-toolkit/core`
- `@ai-application-toolkit/runtime`
- `@ai-application-toolkit/tool`
- `@ai-application-toolkit/context`
- `@ai-application-toolkit/capability`
- `@ai-application-toolkit/workflow`
- `@ai-application-toolkit/guardrail`
- `@ai-application-toolkit/trace`
- `@ai-application-toolkit/cache`
- `@ai-application-toolkit/codegraph` — turn a folder into a multi-language code graph (symbols, imports, references) with LLM context ranking
- `@ai-application-toolkit/anthropic` — Claude provider adapter
- `@ai-application-toolkit/openai` — OpenAI provider adapter
- `@ai-application-toolkit/mcp` — expose tools as a Model Context Protocol server
- `@ai-application-toolkit/vercel-ai` — use tools with the Vercel AI SDK
- `@ai-application-toolkit/otel` — export runtime execution as OpenTelemetry spans

## Release

```bash
pnpm changeset
pnpm version-packages
pnpm release
```

## Documentation

The docs site lives under `apps/docs` and is built with [Mintlify](https://mintlify.com)
(MDX + `docs.json`). Preview it locally:

```bash
npm i -g mint
pnpm dev:docs
```

Deploy target: Mintlify (connect the repo with the docs directory set to `apps/docs`).
