# npm Release

This repository uses Changesets.

## Required secret

Add this GitHub secret:

```txt
NPM_TOKEN
```

## Release flow

```bash
pnpm changeset
git add .changeset
git commit -m "chore: add changeset"
git push
```

On merge to `main`, GitHub Actions will create a release PR or publish packages.
