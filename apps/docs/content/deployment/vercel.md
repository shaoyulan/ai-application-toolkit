# Deploy Docs to Vercel

The documentation site is under `apps/docs`.

## Vercel settings

- Framework Preset: Nuxt
- Root Directory: `apps/docs`
- Build Command: `cd ../.. && pnpm --filter @ai-application-toolkit/docs build`
- Install Command: `cd ../.. && pnpm install --frozen-lockfile`

Nuxt 3 can deploy to Vercel with zero configuration in common cases.
