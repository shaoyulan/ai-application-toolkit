# Vercel Deployment

The docs app is in `apps/docs`.

## Recommended Vercel settings

- Framework preset: Nuxt
- Root directory: `apps/docs`
- Install command: `cd ../.. && pnpm install --frozen-lockfile`
- Build command: `cd ../.. && pnpm --filter @ai-application-toolkit/docs build`

Nuxt 3 and Nuxt Content can be deployed to Vercel.
