# npm Publishing

This monorepo uses Changesets.

## Initial publish checklist

1. Create npm organization or scope.
2. Update package names if needed.
3. Set `NPM_TOKEN` in GitHub secrets.
4. Run `pnpm changeset`.
5. Merge release PR.
