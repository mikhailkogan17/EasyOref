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

| Symptom | Fix |
|---|---|
| Service fails to restart | `ssh pi@raspberrypi.local "journalctl -u easyoref -n 20"` |
| Old version still running | `sudo systemctl restart easyoref` |
| Port 3100 in use | `sudo pkill -9 node` then restart |

### General Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| `easyoref` command not found | NPM global not in PATH | `npm list -g easyoref`, then check `~/.npm-global/bin` is in `$PATH` |
| npm "already published" | Version already on registry | Delete local tag, bump version, retry: `git tag -d vX.Y.Z && npm run release:patch` |
| Service won't start | Missing dependencies | `sudo systemctl status easyoref` then `journalctl -u easyoref -n 50` |
| Port 3100 already in use | Old process still running | `sudo pkill -9 node && sudo systemctl restart easyoref` |

### CRITICAL RULES

- **NEVER** run `npm publish` locally — use `npm run release` (creates tag + publishes)
- **NEVER** manually `git tag` — let `npm run release` handle it
- RPi deploy is ALWAYS via `easyoref update` command, NEVER manual git clone
- systemd service runs as root with `Environment=HOME=/home/pi` (config lookup)
- No Docker on RPi production — only systemd service + redis container

---

## RPi Verification — 2026-04-02

### Environment

| Item | Value |
|---|---|
| **Version** | `easyoref@1.27.1` (npm global) |
| **Services** | `easyoref-ru_tlv-south.service` ✅ active running |
| | `easyoref-he_tlv-south.service` ✅ active running |
| **Redis** | Docker container, `redis://localhost:6379` |
| **Config path (ru)** | `/home/pi/.easyoref/config.ru_tlv-south.yaml` |
| **Config path (he)** | `/home/pi/.easyoref/config.he_tlv-south.yaml` |
| **Systemd env** | `EASYOREF_CONFIG` → per-language YAML file, no other env vars |

### Plan Items — Verification

| # | Fix | Code | RPi Config | Status |
|---|---|---|---|---|
| 1 | GramJS channel ID cache | `gramjs/src/index.ts` — `channelCache` Map, `getChannelEntity()` | N/A (code-level) | ✅ |
| 2 | GramJS `backfillChannelPosts()` | `gramjs/src/index.ts` — exported, called from pre-filter | N/A | ✅ |
| 3 | GramJS warn logging on getChat fail | `gramjs/src/index.ts` — `logger.warn()` | N/A | ✅ |
| 4 | Post-filter soft pass for critical phases | `agent/src/nodes/post-filter-node.ts` — `early_warning`, `red_alert` bypass | N/A | ✅ |
| 5 | Config: two explicit model keys | `shared/src/config.ts` — `filterModel` + `extractModel` | Both configs: `openrouter_filter_model` + `openrouter_extract_model` ✅ | ✅ |
| 6 | Config: YAML-only SSOT | `shared/src/config.ts` — zero `process.env` fallbacks (only `EASYOREF_CONFIG`) | systemd: only `EASYOREF_CONFIG` env var ✅ | ✅ |
| 7 | Remove `confidence_threshold` | Removed from config.ts interface | Not in RPi configs ✅ | ✅ |
| 8 | Remove `langsmith_tracing` / `langsmith_endpoint` | Removed from config.ts interface | Not in RPi configs ✅ | ✅ |
| 9 | Model: filter=`openai/gpt-oss-120b` | Default in config.ts | Both RPi configs ✅ | ✅ |
| 10 | Model: extract=`google/gemini-3.1-flash-lite-preview` | Default in config.ts | Both RPi configs ✅ | ✅ |
| 11 | Fallbacks=`openai/gpt-oss-120b:free` | Default in config.ts | Both RPi configs ✅ | ✅ |
| 12 | Remove `process.env.AREAS` from bot.ts | `bot/src/bot.ts` — removed | N/A | ✅ |

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

| Phase | Initial Delay | Enrich Interval |
|---|---|---|
| `early_warning` | 120s | 60s |
| `red_alert` | 15s | 45s |
| `resolved` | 90s | 150s |

### Watermark Mechanism (buildTracking)

`buildTracking()` in `pre-filter-node.ts` partitions channel posts into `previous` (ts < lastUpdateTs) and `latest` (ts >= lastUpdateTs) buckets. After each enrichment run, `worker.ts` calls `setLastUpdateTs(Date.now())`.

**v1.27.6 fix:** Channels with only `previous` posts are now re-surfaced for retry extraction. Previously they were excluded from `channelsWithUpdates` entirely, causing data loss when the first LLM call failed.

### Noise Filter Rules (pre-filter-node.ts)

| Rule | Condition | Reason |
|---|---|---|
| `oref_channel_long` | OREF_CHANNEL_RE + text > 300 chars | noise |
| `oref_link` | oref.org.il link | noise |
| `comma_list` | 8+ commas | noise (area lists) |
| `time_pattern_list` | 2+ time patterns like (HH:MM) | noise |
| `idf_channel_long` | IDF channel + text > 400 chars | noise |

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

| Version | Date | Changes |
|---|---|---|
| v1.27.6 | 2026-04-04 | fix: re-surface watermarked posts for retry extraction |
| v1.27.5 | 2026-04-03 | feat: add @stranacoil channel + noise filter rejection tracking |
| v1.27.4 | 2026-04-02 | fix: 5 critical bugs from April 2 attack postmortem |
| v1.27.1 | 2026-04-02 | RPi verification baseline |

### RPi Current State (2026-04-04)

| Item | Value |
|---|---|
| **Version** | `easyoref@1.27.6` (npm global) |
| **Services** | `easyoref-ru_tlv-south.service` active |
| | `easyoref-he_tlv-south.service` active |
| **Redis** | Docker container, `redis://localhost:6379` |
| **Node** | v20.19.1 |
| **RAM** | 3.8GB |
| **Crontab** | `0 4 */3 * * sudo reboot` (every 3 days, services auto-restart) |
