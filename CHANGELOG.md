# Changelog

Auto-generated changelog is maintained by [@changesets](https://github.com/changesets/changesets):

**→ [packages/bot/CHANGELOG.md](packages/bot/CHANGELOG.md)**

---

## Historical (pre-changesets)

## [1.1.0] — 2026-03-06

### Added

- **Interactive setup wizard** — `npx easyoref init` walks through config in 4 languages
- **Config stored at** `~/.easyoref/config.yaml` — no more manual file creation
- **Gitleaks** secret scanning in CI and dangerfile
- **CHANGELOG.md**

### Changed

- READMEs rewritten for all 3 languages (EN, RU, HE) with platform-specific Node.js install guides
- `npx easyoref` as the primary install/run method (replaces `npm install -g`)
- Logger now reads Logtail token from YAML config (was hardcoded to env var)
- Docs (architecture, local, rpi) rewritten — removed stale Ollama/LangGraph/Ansible references

### Fixed

- `observability.betterstack_token` from config.yaml was never passed to logger

## [1.0.0] — 2026-02-28

### Added

- **4 languages** — Russian, English, Hebrew, Arabic
- **3 alert types** — early warning, siren, all-clear (resolved)
- **YAML config** — migrated from .env to config.yaml
- **City ID filtering** — resolve numeric IDs to Hebrew area names via cities.json
- **HTML blockquote messages** with emoji per alert type
- **Shelter-oriented descriptions** — "go to shelter", "stay alert", "you can leave"
- **GIF modes** — `funny_cats`, `none`
- **Persistent GIF rotation** — state saved to data dir, no repeats until pool exhausted
- **Custom overrides** — per-alert-type title and description
- **Better Stack (Logtail)** observability integration
- **Docker** multi-arch image (amd64 + arm64) published to GHCR
- **npm** package with OIDC provenance
- **Health endpoint** — `GET /health` on port 3100
- **CI** — typecheck + vitest (32 tests)
- **Pre-commit hooks** — secret detection + typecheck
- **Danger PR checks** — description, lockfile sync
