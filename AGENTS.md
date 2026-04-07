# AI Agent Instructions — EasyOref

## NPM Publishing: OIDC (Trusted Publishers)

### CRITICAL RULE — READ THIS FIRST

**NPM_TOKEN НЕ создаётся вручную. НЕ добавляется в GitHub repo secrets. НИКОГДА.**

EasyOref (как и CyberMem) использует **npm OIDC Trusted Publishers**.
Токен генерируется **динамически** GitHub Actions при каждом publish run.

### Как это работает

1. `permissions: id-token: write` в workflow → GitHub генерирует OIDC JWT
2. `actions/setup-node@v4` с `registry-url: "https://registry.npmjs.org"` → создаёт `.npmrc`
3. `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` — **НЕ нужна** в changesets action env. Она ПЕРЕЗАПИСЫВАЕТ OIDC JWT пустым значением (secret не существует → пустая строка → ENEEDAUTH)
4. `setup-node` с `registry-url` сам создаёт `.npmrc` и инжектит OIDC JWT через env
5. Trusted Publisher настроен на **npmjs.com** (Settings пакета → Publishing access → Trusted Publishers)

### Чеклист для нового пакета

1. На **npmjs.com** → пакет → Settings → Publishing access → Configure trusted publishers:
   - Repository owner: `mikhailkogan17`
   - Repository name: `EasyOref`
   - Workflow filename: `release.yml`
   - Environment: *(пусто)*
2. В workflow: `permissions: id-token: write` ✅
3. В workflow: `registry-url: "https://registry.npmjs.org"` в setup-node ✅
4. В workflow: `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` в env publish step ✅
5. В package.json: `"publishConfig": { "access": "public", "provenance": true }` ✅

### ЗАПРЕЩЕНО

- ❌ Добавлять `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` в env шага publish — это ПЕРЕЗАТИРАЕТ OIDC JWT пустой строкой
- ❌ Предлагать "создай NPM_TOKEN на npmjs.com → скопируй → добавь в GitHub secrets"
- ❌ Предлагать "npmjs.com → Access Tokens → Automation"
- ❌ Путать OIDC (динамический JWT) с классическим automation token (статический)

### Ссылки

- [npm Trusted Publishing](https://docs.npmjs.com/generating-provenance-statements)
- [GitHub OIDC](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect)
- CyberMem reference: `.github/OIDC_PUBLISHING.md`

---

## LangGraph Agent Enrichment Pipeline

### Overview

EasyOref v1.6.0+ includes a **LangGraph.js agentic enrichment pipeline** that monitors Hebrew-language Telegram news channels via GramJS (MTProto), correlates messages with Red Alert events, and enriches bot notifications with context — attack type, ETA, source citations.

### Architecture

```
Red Alert API ──► grammY bot ──► sends initial alert ──► captures {messageId, isCaption}
                                      │
GramJS MTProto ──► monitors 5 news channels ──► BullMQ delayed job (90s)
                                                       │
                                                       ▼
                                              LangGraph pipeline (5 tiers)
                                                       │
                                                       ▼
                                              bot.editMessageText() with enrichment
```

### Files (Monorepo Structure)

```
packages/
├── shared/        # Config, schemas, Redis helpers — shared across all packages
├── monitoring/    # Logger wrapper (pino + Better Stack)
├── gramjs/        # GramJS MTProto client: monitors channels, stores messages in Redis
├── agent/         # LangGraph enrichment pipeline
│   └── src/
│       ├── graph.ts         # LangGraph StateGraph: 5-tier pipeline
│       ├── extract.ts       # LLM extraction with cheap/expensive filter
│       ├── queue.ts         # BullMQ queue: `enrich-alert` jobs
│       ├── worker.ts        # BullMQ worker: runs graph → edits message
│       ├── tools.ts         # MCP tools for clarification
│       ├── redis.ts         # ioredis singleton
│       └── nodes/           # Graph nodes: clarify, filters, message, vote
├── bot/           # Main grammY bot
└── cli/           # CLI commands (init, auth, install, logs)
```

**Build:** `npm run build` → `tsc -b` (uses root tsconfig.json project references)

**Tests:** `npm test` (vitest runs all `packages/*/__tests__/*.test.ts` and `packages/*/src/**/*.test.ts`)

### Models

- **Filter** (pre-filter + post-filter): `openai/gpt-oss-120b` — free 117B MoE, good for cheap first-pass
- **Extract** (structured extraction): `google/gemini-3.1-flash-lite-preview` — paid, precise
- **Fallback** (both): `openai/gpt-oss-120b:free` (`:free` suffix required)
- Configured in `config.yaml` under `ai.openrouter_filter_model` / `ai.openrouter_extract_model`
- Base URL `https://openrouter.ai/api/v1` hardcoded in `graph.ts` — NOT configurable

> **IMPORTANT — model IDs in tests:** Integration tests (`enrichment.integration.test.ts`) use
> free OpenRouter models. **Do NOT hardcode model IDs from memory** — they change.
> Always verify current free models before editing:
> ```bash
> curl -s https://openrouter.ai/api/v1/models | node -e \
>   "const m=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).data; \
>    m.filter(x=>x.pricing?.prompt==='0'&&x.pricing?.completion==='0').forEach(x=>console.log(x.id))"
> ```
> Current free models used in tests: `openai/gpt-oss-120b:free` (supports tool use, 120B params)

### Running Tests

```bash
# Unit tests only (no LLM calls)
npm test

# All tests including LLM integration tests
OPENROUTER_API_KEY="sk-or-v1-..." npm test
```

LLM integration tests are **skipped** without `OPENROUTER_API_KEY` env variable. Set it in your shell or `.env` file. Key is also in `config.yaml` under `ai.openrouter_api_key` but tests require the env var.

### Config Keys (config.yaml)

```yaml
ai:
  enabled: true
  openrouter_api_key: "sk-or-v1-..."
  openrouter_filter_model: "openai/gpt-oss-120b"              # free, cheap first-pass
  openrouter_filter_fallback_model: "openai/gpt-oss-120b:free" # fallback if primary fails
  openrouter_extract_model: "google/gemini-3.1-flash-lite-preview" # paid, structured extraction
  openrouter_extract_fallback_model: "openai/gpt-oss-120b:free"   # fallback if primary fails
  enrich_delay_ms: 20000
  mtproto:
    api_id: 2040
    api_hash: "..."
    session_string: "1AgAOMTQ5..."
  redis_url: "redis://localhost:6379"   # systemd/native: localhost; Docker: redis:6379
```

**Config is YAML-only SSOT** — no `process.env` fallbacks. Only `EASYOREF_CONFIG` env var (path to YAML file) is read from environment.

### Enrichment Format

Unicode superscript citations (¹²³), absolute ETA (~HH:MM¹), inline key:value pairs, clickable source footer. No "Разведка" block — enrichment is appended inline to original alert text.

### Docker

- Redis: `redis:7-alpine` with `--appendonly yes --maxmemory 64mb`
- `redis_url` must be `redis://redis:6379` inside Docker network (NOT `redis://localhost:6379`)
- `depends_on: redis: condition: service_healthy`

### GramJS Auth

- Uses Telegram Desktop public `api_id: 2040` / `api_hash` (hardcoded, not secret)
- QR-code login flow via `auth.ts` → produces `session_string`
- `.gitleaks.toml` has allowlist entry for the public apiHash fingerprint (false positive)

### Deployment

- **RPi production**: Docker compose (recommended)
  ```bash
  # Install (first time)
  ssh pi@raspberrypi.local
  npm i -g @easyoref/cli
  easyoref init
  
  # Update
  easyoref update
  ```
- Config: `~/.easyoref/config.{ru,he}_tlv-south.yaml` (per-language instance)
- Two systemd services: `easyoref-ru_tlv-south` + `easyoref-he_tlv-south`
- Logs: `journalctl -u easyoref-ru_tlv-south -n 50`

### ЗАПРЕЩЕНО (Lethal Laws)

- ❌ **Клонировать git-репозиторий на RPi** — на RPi нет и не должно быть git clone. Деплой ТОЛЬКО через `npm install -g easyoref`
- ❌ **Вызывать `docker compose` / `docker-compose` для деплоя на RPi** — production RPi работает через systemd, НЕ через Docker. Docker compose — только для локальной разработки
- ❌ **Предлагать `docker compose up/down/pull` как способ обновления** — обновление: `sudo npm update -g easyoref && easyoref restart`
- ❌ Предлагать ручной деплой на RPi (только через npm + systemd)
- ❌ Создавать api_id/api_hash на my.telegram.org — используются публичные Telegram Desktop
- ❌ Писать `redis://redis:6379` в systemd/native конфиге — только `redis://localhost:6379` (Docker hostname не существует вне Docker network)
- ❌ Удалять `.gitleaks.toml` allowlist — apiHash fingerprint нужен для прохождения CI

---

## Release & Deploy Pipeline

### 3 Release Flows

#### Flow 1: Install (fresh system)
```bash
# On target system (RPi, server, etc.)
npm install -g easyoref@latest
easyoref init          # configure: bot_token, chat_ids, city_ids, etc.
sudo HOME=$HOME easyoref install   # install systemd service
systemctl status easyoref
```

#### Flow 2: Update (production RPi)
```bash
# From anywhere (triggers via npm script or SSH)
ssh pi@raspberrypi.local "easyoref update"

# Or locally (defined in package.json):
npm run rpi
```

This does: 
- `sudo npm install -g easyoref@latest`
- `sudo systemctl restart easyoref`
- Service auto-restarts with new code

#### Flow 3: Release (local machine)
```bash
# Patch release (1.21.0 → 1.21.1)
npm run release

# Minor release (1.21.0 → 1.22.0)
npm run release:minor

# Major release (1.21.0 → 2.0.0)
npm run release:major
```

This does:
1. **Run all tests** (`scripts/test-ci.js`) — aborts if any test **fails or is skipped**
   - Skipped tests mean `OPENROUTER_API_KEY` is not set and integration tests were not run
   - Set `OPENROUTER_API_KEY` before releasing to pass all 141 tests
2. Bump versions in all 6 packages (`scripts/bump.js`)
3. Auto-commit: `chore: bump to easyoref@X.Y.Z, @easyoref/shared@X.Y.Z, ...`
4. Create git tag: `vX.Y.Z`
5. Push commits + tag to remote
6. Build all packages: `npm run build`
7. Publish all packages to npm: `npm publish --workspaces --no-provenance`
8. Trigger RPi update: `npm run rpi` (runs `easyoref update` on RPi)

### Development Workflow

1. **Make changes** → commit to feature branch
   ```bash
   git checkout -b feature/my-feature
   git add . && git commit -m "feat: description"
   ```

2. **Push & PR** → wait for CI:
   ```bash
   git push -u origin feature/my-feature
   gh pr create --title "feat: description"
   ```

3. **Merge to main** — after CI passes:
   ```bash
   gh pr merge <number> --squash
   ```

4. **Release** — from main branch (automated):
   ```bash
   npm run release          # patch: 1.21.0 → 1.21.1
   npm run release:minor    # minor: 1.21.0 → 1.22.0
   npm run release:major    # major: 1.21.0 → 2.0.0
   ```

   This automatically:
   - **Runs all tests** (aborts if any fail or are skipped — requires `OPENROUTER_API_KEY`)
   - Bumps versions in all packages
   - Commits version bump
   - Tags commit as `vX.Y.Z`
   - Pushes commits + tag
   - Builds all packages
   - Publishes to npm
   - Triggers RPi update (if connected)

### Git Tags & npm Versions

Each release creates a git tag matching the npm version:
- npm v1.22.0 → git tag `v1.22.0`
- Push includes both commit and tag: `git push --tags`

Tags are used for:
- Release tracking: `git log --oneline v1.21.0..v1.22.0`
- Docker image tagging: GitHub Actions builds `ghcr.io/mikhailkogan17/easyoref:v1.22.0`
- Rollback reference: `git checkout v1.21.0`

### RPi Deployment

**Manual update:**
```bash
ssh pi@raspberrypi.local
easyoref update
```

**Automatic** (happens after `npm run release`):
- Script runs: `easyoref update` on RPi
- Installs latest npm package
- Restarts systemd service
- New code live in ~30s

**Troubleshooting:**

| Symptom                   | Fix                                                       |
| ------------------------- | --------------------------------------------------------- |
| Service fails to restart  | `ssh pi@raspberrypi.local "journalctl -u easyoref -n 20"` |
| Old version still running | `sudo systemctl restart easyoref`                         |
| Port 3100 in use          | `sudo pkill -9 node` then restart                         |

### General Troubleshooting

| Problem                      | Cause                       | Fix                                                                                 |
| ---------------------------- | --------------------------- | ----------------------------------------------------------------------------------- |
| `easyoref` command not found | NPM global not in PATH      | `npm list -g easyoref`, then check `~/.npm-global/bin` is in `$PATH`                |
| npm "already published"      | Version already on registry | Delete local tag, bump version, retry: `git tag -d vX.Y.Z && npm run release:patch` |
| Service won't start          | Missing dependencies        | `sudo systemctl status easyoref` then `journalctl -u easyoref -n 50`                |
| Port 3100 already in use     | Old process still running   | `sudo pkill -9 node && sudo systemctl restart easyoref`                             |

### CRITICAL RULES

- **NEVER** run `npm publish` locally — use `npm run release` (creates tag + publishes)
- **NEVER** manually `git tag` — let `npm run release` handle it
- RPi deploy is ALWAYS via `easyoref update` command, NEVER manual git clone
- systemd service runs as root with `Environment=HOME=/home/pi` (config lookup)
- No Docker on RPi production — only systemd service + redis container

---

## RPi Verification — 2026-04-02

### Environment

| Item                 | Value                                                         |
| -------------------- | ------------------------------------------------------------- |
| **Version**          | `easyoref@1.27.1` (npm global)                                |
| **Services**         | `easyoref-ru_tlv-south.service` ✅ active running              |
|                      | `easyoref-he_tlv-south.service` ✅ active running              |
| **Redis**            | Docker container, `redis://localhost:6379`                    |
| **Config path (ru)** | `/home/pi/.easyoref/config.ru_tlv-south.yaml`                 |
| **Config path (he)** | `/home/pi/.easyoref/config.he_tlv-south.yaml`                 |
| **Systemd env**      | `EASYOREF_CONFIG` → per-language YAML file, no other env vars |

### Plan Items — Verification

| #   | Fix                                                   | Code                                                                           | RPi Config                                                             | Status |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------ |
| 1   | GramJS channel ID cache                               | `gramjs/src/index.ts` — `channelCache` Map, `getChannelEntity()`               | N/A (code-level)                                                       | ✅      |
| 2   | GramJS `backfillChannelPosts()`                       | `gramjs/src/index.ts` — exported, called from pre-filter                       | N/A                                                                    | ✅      |
| 3   | GramJS warn logging on getChat fail                   | `gramjs/src/index.ts` — `logger.warn()`                                        | N/A                                                                    | ✅      |
| 4   | Post-filter soft pass for critical phases             | `agent/src/nodes/post-filter-node.ts` — `early_warning`, `red_alert` bypass    | N/A                                                                    | ✅      |
| 5   | Config: two explicit model keys                       | `shared/src/config.ts` — `filterModel` + `extractModel`                        | Both configs: `openrouter_filter_model` + `openrouter_extract_model` ✅ | ✅      |
| 6   | Config: YAML-only SSOT                                | `shared/src/config.ts` — zero `process.env` fallbacks (only `EASYOREF_CONFIG`) | systemd: only `EASYOREF_CONFIG` env var ✅                              | ✅      |
| 7   | Remove `confidence_threshold`                         | Removed from config.ts interface                                               | Not in RPi configs ✅                                                   | ✅      |
| 8   | Remove `langsmith_tracing` / `langsmith_endpoint`     | Removed from config.ts interface                                               | Not in RPi configs ✅                                                   | ✅      |
| 9   | Model: filter=`openai/gpt-oss-120b`                   | Default in config.ts                                                           | Both RPi configs ✅                                                     | ✅      |
| 10  | Model: extract=`google/gemini-3.1-flash-lite-preview` | Default in config.ts                                                           | Both RPi configs ✅                                                     | ✅      |
| 11  | Fallbacks=`openai/gpt-oss-120b:free`                  | Default in config.ts                                                           | Both RPi configs ✅                                                     | ✅      |
| 12  | Remove `process.env.AREAS` from bot.ts                | `bot/src/bot.ts` — removed                                                     | N/A                                                                    | ✅      |

### Tests

- **203 tests** across 11 test files — all passing
- Integration tests require `OPENROUTER_API_KEY` env var (skipped without it)

### RPi Config Snapshot (models section)

Both ru and he configs have identical AI blocks:
```yaml
ai:
  openrouter_filter_model: "openai/gpt-oss-120b"
  openrouter_filter_fallback_model: "openai/gpt-oss-120b:free"
  openrouter_extract_model: "google/gemini-3.1-flash-lite-preview"
  openrouter_extract_fallback_model: "openai/gpt-oss-120b:free"
```

### Note

RPi is running v1.27.1. Next `npm run release` + `easyoref update` will deploy v1.27.2+ with all code fixes.

---

## Enrichment Pipeline — Deep Dive

### Graph Pipeline Flow

```
pre-filter → extract → post-filter → vote → synthesize → [shouldClarify?] → clarify/edit
```

### Phase Timing Constants

| Phase           | Initial Delay | Enrich Interval |
| --------------- | ------------- | --------------- |
| `early_warning` | 120s          | 60s             |
| `red_alert`     | 15s           | 45s             |
| `resolved`      | 90s           | 150s            |

### Watermark Mechanism (buildTracking)

`buildTracking()` in `pre-filter-node.ts` partitions channel posts into `previous` (ts < lastUpdateTs) and `latest` (ts >= lastUpdateTs) buckets. After each enrichment run, `worker.ts` calls `setLastUpdateTs(Date.now())`.

**v1.27.6 fix:** Channels with only `previous` posts are now re-surfaced for retry extraction. Previously they were excluded from `channelsWithUpdates` entirely, causing data loss when the first LLM call failed.

### Noise Filter Rules (pre-filter-node.ts)

| Rule                | Condition                          | Reason             |
| ------------------- | ---------------------------------- | ------------------ |
| `oref_channel_long` | OREF_CHANNEL_RE + text > 300 chars | noise              |
| `oref_link`         | oref.org.il link                   | noise              |
| `comma_list`        | 8+ commas                          | noise (area lists) |
| `time_pattern_list` | 2+ time patterns like (HH:MM)      | noise              |
| `idf_channel_long`  | IDF channel + text > 400 chars     | noise              |

### Monitored Channels (17 total)

`@newsflashhhj`, `@yediotnews25`, `@Trueisrael`, `@israelsecurity`, `@N12LIVE`, `@moriahdoron`, `@divuhim1234`, `@GLOBAL_Telegram_MOKED`, `@pkpoi`, `@lieldaphna`, `@News_cabinet_news`, `@yaronyanir1299`, `@ynetalerts`, `@idf_telegram`, `@israel_9`, `@stranacoil` + 1 private channel

### GramJS Post Timestamps

- **Event-based** (real-time): `ts: Date.now()` — when message received
- **Backfill** (historical): `msg.date * 1000` — Telegram server timestamp
- Watermark comparison uses `Date.now()` values

### Carry-Forward (Cross-Phase Persistence)

Voted insights are saved to Redis via `saveVotedInsights()` in synthesize-node. When a new phase starts (e.g., `red_alert` after `early_warning`), `runEnrichment()` in `graph.ts` loads previous insights as `previousInsights`. Vote-node merges them into the consensus. Extract-node deduplicates via `seenUrls` from `previousInsights` to prevent double-extraction.

### LangSmith Integration

- Project name: `easyoref` (single project for both HE and RU instances)
- Traces include: phase, alertType, alertAreas, channelsWithUpdates, extraction results
- Useful for post-mortem analysis of why enrichment failed on specific attacks

---

## Postmortem — April 1-3 2026 Attacks

### Root Cause — Watermark Data Loss

**The `buildTracking()` watermark mechanism was too aggressive:**

1. **T=0**: Alert fires, session created, initial enrichment enqueued with delay
2. **T=2min**: First enrichment runs. `lastUpdateTs=0` → all posts go to `latest` → LLM extracts (or fails). `setLastUpdateTs(Date.now())` after.
3. **T=3min**: Second enrichment. Posts from before T=2min have `ts < lastUpdateTs` → `previous` only. If no NEW posts arrived → `channelsWithUpdates=[]` → **skip entirely**.
4. This continues for the ENTIRE phase window.

**If the first LLM call fails or returns `{}` (empty), ALL channel data is LOST FOREVER** — subsequent runs won't see those posts again because they're all watermarked as "previous" and channels with only "previous" posts were excluded from `channelsWithUpdates`.

### Evidence from LangSmith

- **April 1**: HE early_warning first run → `"no posts found"` (too early, channels hadn't posted yet). RU early_warning → found @N12LIVE posts but LLM returned `{}` (empty extraction). All subsequent runs for both instances had `channelsWithUpdates: []` → zero insights.
- **April 3 16:11**: All RU traces show `"pre-filter-node: all posts filtered as noise"` with `previousInsights: []` — same pattern.
- **April 3 03:12**: Only `@divuhim1234` and `@N12LIVE` contributed data; HE extracted `country_origins: Iran` and `eta: 2 minutes` but RU got nothing.

### Fix (v1.27.6)

Modified `buildTracking()` in `pre-filter-node.ts` to re-surface channels that have ONLY `previous` (already-watermarked) posts. Previously-seen posts are moved to `unprocessedMessages` so extract-node can retry extraction. URL dedup in extract-node (`seenUrls` from `previousInsights`) prevents double-extraction when carry-forward data exists.

### Tests Updated

- Changed test "channel with only old posts (no new) is excluded" → "channel with only old posts is re-surfaced for retry extraction"
- **206 tests** across 11 test files — all passing (v1.27.6)

---

## Version History (Recent)

| Version | Date       | Changes                                                         |
| ------- | ---------- | --------------------------------------------------------------- |
| v1.27.6 | 2026-04-04 | fix: re-surface watermarked posts for retry extraction          |
| v1.27.5 | 2026-04-03 | feat: add @stranacoil channel + noise filter rejection tracking |
| v1.27.4 | 2026-04-02 | fix: 5 critical bugs from April 2 attack postmortem             |
| v1.27.1 | 2026-04-02 | RPi verification baseline                                       |

### RPi Current State (2026-04-04)

| Item         | Value                                                           |
| ------------ | --------------------------------------------------------------- |
| **Version**  | `easyoref@1.27.6` (npm global)                                  |
| **Services** | `easyoref-ru_tlv-south.service` active                          |
|              | `easyoref-he_tlv-south.service` active                          |
| **Redis**    | Docker container, `redis://localhost:6379`                      |
| **Node**     | v20.19.1                                                        |
| **RAM**      | 3.8GB                                                           |
| **Crontab**  | `0 4 */3 * * sudo reboot` (every 3 days, services auto-restart) |

---

## EasyOref 2.0.0 Roadmap

**Branch:** `v2` off `main`. Phases 0-1 committed (`a0d49ce`, `1e4999a`).

### V2 Code Rules (ENFORCE ALWAYS)

1. **Every node = separate file** in `packages/agent/src/nodes/`
2. **All helpers outside nodes** — utils/ only. Node file contains ONLY agent const + exported node function
3. **Node file strict format:**
   ```ts
   // imports
   const agentOpts = { model, prompt, ... };
   
   export async function myNode(state: AgentState): Promise<Partial<AgentState>> { ... }
   ```
4. **No legacy / no deprecation** — single user of v1. No backward compat, no `@deprecated`, no "legacy" comments, no stale TODOs
5. **Tests = new logic only** — no `confidenceThreshold`, `config.areas`, `config.language`, `config.chatIds`, `config.cityIds` in mocks. Redis cleanup after update (no old keys survive)
6. **YAML-only SSOT** — `process.env` only for `EASYOREF_CONFIG` path. Zero env fallbacks for config fields

---

### Phase 0-1 Code Review Findings (FIXED in Phase 2) ✅

All findings below have been resolved. Kept for reference.

<details>
<summary>Original findings (collapsed)</summary>

#### Helpers inside nodes (Rule 2 violations):
- `pre-filter-node.ts`: `noiseReason()`, `isNoise()`, `toNewsMessage()`, `buildTracking()` → moved to `utils/noise-filter.ts` + `utils/tracking.ts`
- `extract-node.ts`: `getPhaseRule()`, `extractFromChannel()` → moved to `utils/phase-rules.ts` + `utils/channel-extract.ts`
- `synthesize-node.ts`: `fieldKeyToKind()` → moved to `utils/field-key-map.ts`
- `synthesize-node.ts`: `buildConsensus()`, `groupInsightsByKind()`, `computeOptions()` → moved to `utils/consensus.ts`
- `edit-node.ts`: `inlineCites()` → DELETED (unused). Deprecated re-exports removed.

#### Dead code (Rule 4 violations):
- `pre-filter-node.ts`: `isNoise()` — DELETED
- `edit-node.ts`: backwards-compat re-exports — DELETED
- `message.ts`: `CitationMap` + `buildCitationMap()` — DELETED
- `schemas.ts`: stale TODO — DELETED

#### Agent opts not top-level (Rule 3 violations):
- `post-filter-node.ts`: fixed — hoisted to top-level
- `synthesize-node.ts`: fixed — hoisted to top-level

#### Stale test mocks (Rule 5 violations):
- All `confidenceThreshold`, `areas`, `language`, `mcpTools`, `clarifyFetchCount` removed from test mocks
- `config.test.ts`: `resolveCityIds` test suite — DELETED

</details>

---

### Phase 2: Code Hygiene + Enrichment v2 ✅

**Status:** COMPLETED. All code review findings fixed, pipeline simplified 7→5 nodes, tests green (168/168).

**What was done:**
- Created utils: `noise-filter.ts`, `tracking.ts`, `phase-rules.ts`, `channel-extract.ts`, `field-key-map.ts`, `consensus.ts`, `resolve-area.ts`
- Deleted: `clarify-node.ts`, `vote-node.ts`, `tools/` directory, `contradictions.ts`, `clarify.test.ts`
- Graph: 5 nodes — `pre-filter → [Send: extract-channel ×N] → post-filter → synthesize → edit`
- Vote logic: deterministic `buildConsensus()` merged into synthesize flow (in `utils/consensus.ts`)
- Config-driven: `max_enrich_runs`, `phase_initial_delay_ms`, `phase_enrich_delay_ms`, `phase_timeout_ms` moved from hardcoded to YAML
- Worker: run-limited to `config.agent.maxEnrichRuns` (default 3), no infinite loop
- All 168 tests pass across 11 test files

**Current file structure (agent package):**
```
packages/agent/src/
├── graph.ts              # StateGraph: 5-node pipeline + AgentState
├── index.ts              # Public API re-exports
├── models.ts             # LLM model instances + invokeWithFallback
├── nodes/
│   ├── pre-filter-node.ts    # Noise filter + tracking (imports from utils/)
│   ├── extract-node.ts       # Agent opts + extractChannelNode
│   ├── post-filter-node.ts   # Area relevance + confidence validation
│   ├── synthesize-node.ts    # Voting + LLM synthesis (imports buildConsensus from utils/)
│   └── edit-node.ts          # Telegram message editing
├── utils/
│   ├── noise-filter.ts       # noiseReason(), toNewsMessage()
│   ├── tracking.ts           # buildTracking(), FilterStats
│   ├── phase-rules.ts        # getPhaseRule()
│   ├── channel-extract.ts    # extractFromChannel()
│   ├── field-key-map.ts      # fieldKeyToKind()
│   ├── consensus.ts          # buildConsensus(), groupInsightsByKind(), computeOptions()
│   ├── resolve-area.ts       # resolveArea() — 3-tier area matching
│   └── message.ts            # buildEnrichedMessage(), insertBeforeBlockEnd(), formatCitations()
└── runtime/
    ├── worker.ts             # BullMQ worker (config-driven max runs)
    ├── queue.ts              # BullMQ queue
    ├── redis.ts              # ioredis singleton
    ├── auth.ts               # GramJS auth
    └── dry-run.ts            # CLI dry-run
```

---

### Phase 3: Q&A Graph (Chat with Bot)

**Goal:** Second LangGraph graph — RAG-style Q&A. Private messages to bot.

**Prerequisites:** Phase 2 complete ✅. The enrichment graph (`packages/agent/src/graph.ts`) is the reference for how to build a LangGraph StateGraph.

#### Architecture

```
User private message → grammY handler → Q&A graph → response
                                          │
                    ┌─────────────────────┤
                    ▼                     ▼
           intent-classify        context-gather
           (deterministic)    (Redis + Oref API)
                    │                     │
                    └──────┬──────────────┘
                           ▼
                    answer-generate
                    (LLM + Zod output)
```

1. **New graph: `qa-graph.ts`** — 3 nodes, strict V2 format:
   ```
   intent-classify → context-gather → answer-generate
   ```
   - **intent-classify** (deterministic, 0 tokens): regex + keyword matching. Categories: `current_alert`, `recent_history`, `general_security`, `bot_help`
   - **context-gather**: Redis session data (`getSession`, `getVotedInsights`) + Oref history API (`https://www.oref.org.il/WarningMessages/History/AlertsHistory.json`). Reuses alert_history logic from removed tools.
   - **answer-generate**: LLM → structured answer. Zod-validated output: `{ text: LocalizedValue, sources: string[] }`

2. **Bot handler** — `packages/bot/src/handlers/qa.ts`:
   - `bot.on("message:text")` for private chats only (filter: `ctx.chat.type === "private"`)
   - Rate limiter: 5 questions/min per user (Redis INCR + EXPIRE counter)
   - Premium gate: check `UserConfig.tier === "pro"` (Phase 6). For now, allow all.
   - Typing indicator: `ctx.replyWithChatAction("typing")` while processing
   - Error handling: catch LLM failures, respond with "I couldn't process your question" instead of crashing

3. **New files to create:**
   - `packages/agent/src/qa-graph.ts` — StateGraph definition + QaState type
   - `packages/agent/src/nodes/qa/intent-node.ts` — deterministic classifier
   - `packages/agent/src/nodes/qa/context-node.ts` — Redis + API data fetch
   - `packages/agent/src/nodes/qa/answer-node.ts` — LLM answer generation
   - `packages/bot/src/handlers/qa.ts` — grammY message handler
   - `packages/agent/__tests__/qa-graph.test.ts` — unit tests

4. **Key implementation details:**
   - Intent patterns (regex):
     - `current_alert`: `/alert|מתקפה|צבע אדום|ракет|тревог/i`
     - `recent_history`: `/history|yesterday|אתמול|вчера|история/i`
     - `bot_help`: `/help|start|עזרה|помощь/i`
     - Default: `general_security`
   - Context-gather reads: `getSession(alertId)` for current enrichment data, `getVotedInsights(alertId)` for consensus
   - Oref history API: `GET https://www.oref.org.il/WarningMessages/History/AlertsHistory.json` (public, no auth)
   - Answer model: use `config.agent.filterModel` (cheap, fast) for Q&A answers
   - Answer must include `language` field from `UserConfig` to respond in user's preferred language

5. **Config additions:**
   ```yaml
   ai:
     qa_rate_limit_per_min: 5        # max questions per user per minute
     qa_model: "openai/gpt-oss-120b" # model for Q&A answers (default: filterModel)
   ```

6. **Testing:**
   - Unit test intent-node with regex patterns
   - Unit test answer-node with mocked LLM
   - Integration test: full Q&A graph with mocked context

---

### Phase 4: Inline Mode (@easyorefbot)

**Goal:** `@easyorefbot` inline queries — status widget + Q&A.

**Prerequisites:** Phase 3 complete (Q&A graph).

1. **Empty query** → `InlineQueryResultArticle` with current alert status:
   - Title: "Current Status" / "Текущий статус"
   - Description: last alert time + type + areas (from Redis session)
   - Message text: formatted status summary

2. **Text query** → run Q&A graph → return answer as article:
   - Title: first 50 chars of answer
   - Description: source count
   - Message text: full answer

3. **Cache** answers for 30s (`cache_time: 30` in `answerInlineQuery`)

4. **grammY handler:**
   ```ts
   bot.on("inline_query", async (ctx) => {
     const query = ctx.inlineQuery.query.trim();
     if (!query) {
       // status widget
     } else {
       // Q&A via qa-graph
     }
     await ctx.answerInlineQuery(results, { cache_time: 30 });
   });
   ```

5. **New files:**
   - `packages/bot/src/handlers/inline.ts` — inline query handler

6. **Rate limiting:** same Redis counter as Q&A (shared limit)

**Depends on:** Phase 3

---

### Phase 5: Shelter Search

**Goal:** Location → nearest shelters with distances.

**Prerequisites:** None — can run in parallel with Phases 2-4.

#### Research: Existing APIs & Data Sources

Before implementing, research these existing solutions. The subagent executing this phase MUST check which options are still available:

1. **Pikud HaOref Shelter API** — check if `https://www.oref.org.il/` has a public shelter endpoint. Look for `/NAShelters/`, `/Areas/`, or similar paths.

2. **Existing Telegram bots** — research working shelter bots:
   - `@MiklutBot` (מקלטבוט) — may have shelter location data
   - `@PikudHaorefBot` — official or unofficial, check if exposes shelter data
   - Search for "מקלט" or "shelter" in Telegram bot search

3. **Open data sources:**
   - `data.gov.il` — Israel open data portal, search for "מקלט" (shelter) datasets
   - Municipal open data (Tel Aviv, Jerusalem, Haifa) — some cities publish shelter GeoJSON
   - OpenStreetMap — `amenity=shelter` + `shelter_type=public_protection` tags for Israel

4. **Google Maps / Places API** — `type=civil_defense` or keyword search "מקלט ציבורי" (has cost implications)

#### Implementation Plan

1. **Data acquisition** — based on research:
   - **Option A (preferred):** If Oref/gov API exists → use it live. No static dataset needed.
   - **Option B:** If open data CSV/GeoJSON found → import to `packages/shared/src/data/shelters.json` (~15K entries)
   - **Option C:** If no API → scrape from municipal sites (one-time) → static JSON

2. **Geosearch** — `findNearestShelters(lat, lng, limit=5, maxDistanceKm=2)`:
   - Haversine formula for distance calculation
   - O(n) scan for <15K entries (no spatial index needed)
   - Returns: `{ name, address, lat, lng, distanceKm, googleMapsUrl }[]`

3. **Bot handler** — `bot.on("message:location")`:
   - Extract `latitude`, `longitude` from message
   - Call `findNearestShelters(lat, lng)`
   - Format as numbered list with Google Maps links: `https://www.google.com/maps/dir/?api=1&destination={lat},{lng}`
   - Include walking time estimate (assuming 5 km/h)

4. **Also support:** text address → geocode → shelters (Phase 5b, optional)

5. **Free feature** — safety critical, available to ALL tiers (free + pro)

6. **New files:**
   - `packages/shared/src/data/shelters.json` (if static dataset)
   - `packages/shared/src/shelter.ts` — `findNearestShelters()`, `haversine()`
   - `packages/bot/src/handlers/shelter.ts` — location message handler
   - `packages/shared/__tests__/shelter.test.ts` — unit tests

7. **Config additions:**
   ```yaml
   shelter:
     max_distance_km: 2       # max search radius
     max_results: 5            # max shelters to return
     source: "static"          # "static" | "api" (if live API found)
     api_url: ""               # populated if live API discovered
   ```

**No dependencies** — parallel with Phase 2-4.

---

### Phase 6: Monetization (Freemium)

**Goal:** Free/pro tier separation. No payment integration — admin `/grant` only.

**Prerequisites:** Phase 1 complete ✅ (UserConfig schema + multi-user already implemented).

| Feature                  | Free                             | Pro                                           |
| ------------------------ | -------------------------------- | --------------------------------------------- |
| Alerts (Oref → Telegram) | ✅ private msg, **ETA time only** | ✅ **chat integration** (groups)               |
| Shelter search           | ✅                                | ✅                                             |
| AI enrichment metadata   | ❌                                | ✅ full (origin, rockets, interceptions, etc.) |
| Q&A chat                 | ❌                                | ✅                                             |
| Inline Q&A               | ❌                                | ✅ (inline status widget: free)                |

**Free tier details:**
- Private message only (no group/channel support)
- Alert message shows: alert type, areas, **ETA time** (from enrichment `eta` field) — nothing else
- No enrichment editing (message stays static after send)
- No Q&A

**Pro tier details:**
- Chat/group/channel integration (bot can be added to group chats)
- Full AI enrichment: origin, rocket count, interceptions, casualties, damage, inline citations
- Message edited with enrichment data in real-time
- Q&A chat + inline Q&A

#### Implementation Details

1. **UserConfig.tier** — already exists as `"free" | "premium"` in `packages/shared/src/schemas.ts`:
   - Rename `"premium"` → `"pro"` (search: `UserConfig`, `tier`, `premium`)
   - Default tier for new users: `"free"`

2. **Gate middleware** — `packages/bot/src/middleware/tier.ts`:
   ```ts
   export function requirePro(ctx: Context, next: NextFunction) {
     const user = getUserConfig(ctx.chat.id);
     if (user?.tier !== "pro") {
       return ctx.reply("This feature requires Pro tier. Contact admin.");
     }
     return next();
   }
   ```

3. **Alert fanout** — modify `packages/bot/src/bot.ts` alert sending logic:
   - Free users: send stripped message with ETA only → `buildFreeAlertMessage(alertType, areas, eta)`
   - Pro users: send full message → proceed with enrichment pipeline (edit message later)
   - Free users: do NOT enqueue enrichment job (no message editing)

4. **Admin commands** — add to bot:
   - `/grant <chatId>` — set `tier: "pro"` for chatId in Redis
   - `/revoke <chatId>` — set `tier: "free"` for chatId in Redis
   - `/users` — list all registered users with their tier
   - Only allow from admin chatId(s) configured in YAML:
     ```yaml
     admin_chat_ids: [123456789]  # Telegram user IDs with admin access
     ```

5. **New files:**
   - `packages/bot/src/middleware/tier.ts` — tier gate middleware
   - `packages/bot/src/handlers/admin.ts` — `/grant`, `/revoke`, `/users` commands
   - `packages/bot/src/__tests__/tier.test.ts` — unit tests

6. **Modified files:**
   - `packages/shared/src/schemas.ts` — rename `"premium"` → `"pro"` in UserConfig
   - `packages/shared/src/store.ts` — add `setUserTier(chatId, tier)` helper
   - `packages/bot/src/bot.ts` — add tier check in alert fanout, register admin handlers
   - `packages/shared/src/config.ts` — add `admin_chat_ids` to ConfigYaml

**Depends on:** Phase 1 ✅

---

### Phase 7: Stability Hardening

**Goal:** High SLA without manual QA.

1. **Snapshot tests** — golden input/output pairs for extract-node + synthesize-node
2. **Zod contract tests** — every cross-package boundary validates with Zod
3. **LLM guardrails** — max field lengths, banned patterns, hallucination check (every fact → ≥1 source URL)
4. **Canary mode** — `config.yaml: canary: true` → synthetic test alert on startup
5. **Health check v2** — `GET /health` returns `status`, `lastAlertTs`, `lastEnrichmentTs`, `registeredUsers`, `redisConnected`, `gramjsConnected`
6. **BullMQ DLQ** — dead letter queue for failed enrichment jobs → log to Better Stack

---

### Dependency Graph

```
Phase 0 ✅ → Phase 1 ✅
  ↓
Phase 2 ✅ (Hygiene + Enrichment v2)
  ↓
  ├── Phase 3 (Q&A) ──→ Phase 4 (Inline)
  ├── Phase 5 (Shelter) [parallel, no deps]
  └── Phase 6 (Monetization) [parallel after Phase 1]
        ↓
Phase 7 (Stability) — runs through end
```

**Critical path:** Phase 2 ✅ → Phase 3 → Phase 4 → Phase 7

**Parallelizable now:** Phase 5 (Shelter) + Phase 6 (Monetization) can start immediately.
Phase 3 (Q&A) can also start immediately since Phase 2 is done.
