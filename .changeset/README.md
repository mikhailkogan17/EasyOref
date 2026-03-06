# Changesets

This project uses [changesets](https://github.com/changesets/changesets) for version management.

## Workflow

### When you make a change

```bash
npx changeset
```

Select `easyoref`, choose bump type (patch/minor/major), write a summary.

This creates a file in `.changeset/` — commit it with your PR.

### To release

The `release.yml` workflow handles everything automatically:
1. Collects all changesets → bumps version → updates CHANGELOG.md
2. Publishes to npm with OIDC provenance
3. Publishes Docker image to GHCR
4. Creates GitHub Release with changelog
