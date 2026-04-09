---
name: release-pipeline
description: "Commit, push, and release EasyOref to npm + RPi. Use when: bug fix is done, tests pass, ready to ship. Handles git commit, version bump, npm publish, RPi deploy. Use after fixing a bug and writing tests."
argument-hint: "Describe what was fixed (used for commit message)"
---

# Release Pipeline

Commit, test, bump, publish, and deploy a fix to production RPi.

## When to Use

- Bug fix is complete and tests pass
- Ready to release a new patch/minor/major version
- After writing regression tests

## Prerequisites

- All changes staged or ready to commit
- Tests pass locally (`npm test`)
- Working SSH to RPi (`ssh pi@raspberrypi.local`)

## Procedure

### Step 1: Verify Tests Pass

```bash
npm test
```

ALL tests must pass with zero skips. If integration tests are skipped, set `OPENROUTER_API_KEY`:
```bash
OPENROUTER_API_KEY="$(grep openrouter_api_key config.yaml | head -1 | awk '{print $2}' | tr -d '\"')" npm test
```

### Step 2: Review Changes

```bash
git diff --stat
git diff
```

Verify only the intended files are modified. Common change sets for a postmortem fix:

| Pipeline | Typical files changed |
|---|---|
| Enrichment | `packages/agent/src/graphs/enrichment/nodes/*.ts`, `packages/agent/src/utils/*.ts`, `packages/agent/__tests__/*.test.ts` |
| Q&A | `packages/agent/src/graphs/qa/nodes/*.ts`, `packages/agent/__tests__/qa-graph.test.ts` |
| Bot | `packages/bot/src/bot.ts`, `packages/bot/src/__tests__/bot.test.ts` |
| Shared | `packages/shared/src/store.ts`, `packages/shared/src/schemas.ts` |
| GramJS | `packages/gramjs/src/index.ts`, `packages/gramjs/__tests__/monitor.test.ts` |

### Step 3: Commit

Format: `fix: <concise description>`

Examples:
- `fix: sendMetaReply fires on origin-only enrichment`
- `fix: cooldown persists to Redis across restarts`
- `fix: GramJS EditedMessage handler for channel edits`
- `fix: ETA pass-through instead of absolute conversion`

```bash
git add -A
git commit -m "fix: <description>"
```

For multi-bug fixes from a postmortem:
```bash
git commit -m "fix: <primary fix>

- <fix 1 detail>
- <fix 2 detail>
- <fix 3 detail>"
```

### Step 4: Push to Remote

```bash
git push
```

If on a feature branch, create PR instead:
```bash
git push -u origin $(git branch --show-current)
gh pr create --title "fix: <description>"
```

### Step 5: Release

**Patch release** (most common for bug fixes):
```bash
npm run release
```

**Minor release** (new features):
```bash
npm run release:minor
```

This automatically:
1. Runs ALL tests (aborts if any fail or skip)
2. Bumps versions in all 6 packages
3. Creates git tag `vX.Y.Z`
4. Pushes commits + tag
5. Builds all packages
6. Publishes to npm
7. Waits 150s for CDN propagation
8. Triggers RPi update via SSH

### Step 6: Verify RPi Deploy

After release completes (~3-4 min):
```bash
ssh pi@raspberrypi.local "easyoref --version"
ssh pi@raspberrypi.local "systemctl status easyoref"
```

Check logs for clean startup:
```bash
ssh pi@raspberrypi.local "journalctl -u easyoref -n 20 --no-pager"
```

### Step 7: Update AGENTS.md

If the fix came from an attack postmortem, update the postmortem section in `AGENTS.md`:
- Add version to the Version History table
- Update "RPi Current State" version if applicable
- Add the postmortem section with root causes, evidence, files modified

## Troubleshooting

| Problem | Fix |
|---|---|
| `npm ERR! already published` | Version already on registry. Delete local tag: `git tag -d vX.Y.Z`, bump again |
| Tests skip (no API key) | `export OPENROUTER_API_KEY=$(grep openrouter_api_key config.yaml \| head -1 \| awk '{print $2}' \| tr -d '"')` |
| RPi SSH timeout | Check `ping raspberrypi.local`, ensure on same network |
| RPi still on old version | `ssh pi@raspberrypi.local "sudo npm install -g easyoref@latest && sudo systemctl restart easyoref"` |

## CRITICAL Rules

- **NEVER** run `npm publish` directly — always use `npm run release`
- **NEVER** manually create git tags — let `npm run release` handle it
- **NEVER** skip tests before releasing
- **NEVER** force push to main
- Releases from `main` branch only (unless explicitly on a feature branch)
