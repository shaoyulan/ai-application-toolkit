# Contributing

Thanks for your interest in improving the AI Application Toolkit!

## Prerequisites

- Node.js >= 20 (the repo is developed on Node 22 — see `.nvmrc`)
- pnpm 9 (`corepack enable` will provide the pinned version)

## Getting started

```bash
pnpm install
pnpm build
```

## Development workflow

This is a Turborepo + pnpm monorepo. The common tasks run across every package:

```bash
pnpm lint        # eslint
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest
pnpm coverage    # vitest with coverage thresholds
pnpm build       # tsc / nuxt build
```

Run a single package's tasks with a filter:

```bash
pnpm --filter @ai-application-toolkit/runtime test
```

## Architecture rules

`AGENTS.md` is the source of truth for the architecture (layering, dependency
direction, immutability, guardrails-as-middleware, tracing). Please read it
before adding a feature, and keep changes within the allowed dependency
direction.

## Before opening a pull request

1. Identify the layer your change belongs to and respect the dependency rules.
2. Add or update tests — coverage thresholds are enforced in CI.
3. Update docs and any affected README.
4. Add a changeset for public API changes:

   ```bash
   pnpm changeset
   ```

5. Make sure `pnpm lint && pnpm typecheck && pnpm test && pnpm coverage && pnpm build` all pass.

## Releases

Releases are automated with [Changesets](https://github.com/changesets/changesets).
Merging the generated "Version Packages" PR publishes the changed packages to npm.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](./LICENSE).
