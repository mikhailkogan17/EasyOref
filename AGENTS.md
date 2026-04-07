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
├── shared/        # Config, schemas, Redis helpers, shelter search, i18n — shared across all
├── monitoring/    # Logger wrapper (pino + Better Stack)
├── gramjs/        # GramJS MTProto client: monitors channels, stores messages in Redis
├── agent/         # LangGraph pipelines (enrichment + Q&A)
│   └── src/
│       ├── graphs/
│       │   ├── enrichment/
│       │   │   ├── enrichment-graph.ts  # StateGraph: 5-node enrichment pipeline
│       │   │   └── nodes/               # pre-filter, extract, post-filter, synthesize, edit
│       │   └── qa/
│       │       ├── qa-graph.ts          # StateGraph: 3-node Q&A pipeline
│       │       └── nodes/               # intent, context, answer
│       ├── utils/           # Shared helpers: consensus, guardrails, message, noise-filter, etc.
│       ├── runtime/         # BullMQ worker/queue, canary, Redis, auth, dry-run
│       ├── models.ts        # LLM model instances + invokeWithFallback
│       └── index.ts         # Public API re-exports
├── bot/           # Main grammY bot + handlers (shelter, Q&A, inline, admin, tier middleware)
└── cli/           # CLI commands (init, auth, install, logs)
```

**Build:** `npm run build` → `tsc -b` (uses root tsconfig.json project references)

**Tests:** `npm test` (vitest runs all `packages/*/__tests__/*.test.ts` and `packages/*/src/**/*.test.ts`)

### Models

- **Filter** (pre-filter + post-filter): `openai/gpt-oss-120b` — free 117B MoE, good for cheap first-pass
- **Extract** (structured extraction): `google/gemini-3.1-flash-lite-preview` — paid, precise
- **Fallback** (both): `openai/gpt-oss-120b:free` (`:free` suffix required)
- Configured in `config.yaml` under `ai.openrouter_filter_model` / `ai.openrouter_extract_model`
- Base URL `https://openrouter.ai/api/v1` hardcoded in `models.ts` — NOT configurable

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
   - Set `OPENROUTER_API_KEY` before releasing to pass all 256 tests
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

- **256 tests** across 17 test files — all passing
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
pre-filter → [Send: extract-channel ×N] → post-filter → synthesize → edit
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

Voted insights are saved to Redis via `saveVotedInsights()` in synthesize-node. When a new phase starts (e.g., `red_alert` after `early_warning`), `runEnrichment()` in `enrichment-graph.ts` loads previous insights as `previousInsights`. `buildConsensus()` (in `utils/consensus.ts`) merges them into the consensus. Extract-node deduplicates via `seenUrls` from `previousInsights` to prevent double-extraction.

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
- **256 tests** across 17 test files — all passing (v1.27.6)

---

## Postmortem — April 7 2026 Attack (09:05)

### 5 Bugs from v2.0.1

**Bug #1: No metadata reply after early_warning enrichment**
- **Root Cause:** `sendMetaReply` only fired for `alertType === "early_warning"`. But early_warning initial delay = 120s, red_alert arrives ~5min later → session upgrades to `red_alert` BEFORE enrichment runs → worker runs with `session.phase = "red_alert"` → `sendMetaReply` skips.
- **Fix:** Changed guard from `alertType !== "early_warning"` to `alertType === "resolved"` return — meta reply now fires for ANY non-resolved phase.

**Bug #2: Red alert message in English instead of Russian**
- **Root Cause:** `session.baseText = formatMessage(alertType, areas, "en")` (English canonical). Edit-node used this single English text as base for ALL users via `buildEnrichedMessage(input.currentText, ...)`.
- **Fix:** Added `baseText` field to `TelegramMessage` schema. bot.ts stores per-user `baseText = formatMessage(alertType, userAreaLabel, lang)`. Edit-node uses `t.baseText ?? input.currentText`.

**Bug #3: ETA neuroslop (~09:17 instead of ~09:12, then changed to pass-through)**
- **Root Cause:** Session `alertTs` updated to red_alert time (09:10). Sources say "7 min" from early_warning (09:05). LLM computed 09:10+7=09:17.
- **Initial fix:** Added `sessionStartTs` to pass early_warning time. LLM used `earlyWarningTime` for ETA.
- **Final fix (user request):** ETA should NOT be converted to absolute time at all. LLM now passes through the source format as-is — "~7 min" stays "~7 мин"/"~7 min"/"~7 דק'"/"~7 دقائق". If source has absolute time, that's respected too.

**Bug #4: Resolved message has no metadata blockquote (carry-forward broken)**
- **Root Cause:** `getEnrichment()` (v1 relic) never populated in v2 pipeline. Carry-forward in bot.ts used this empty function → `legacyInsights` always empty.
- **Fix:** Added `saveSynthesizedInsights()`/`getSynthesizedInsights()` to store.ts. Edit-node saves synthesized insights after each run. bot.ts carry-forward loads from `getSynthesizedInsights()`.

**Bug #5: Free group gets NO alerts**
- **Root Cause:** `if (!isPro && user.chatId.startsWith("-")) continue;` in bot.ts skipped ALL free groups.
- **Fix:** Removed the `continue` guard. Free groups now receive basic alerts (no enrichment metadata, ETA only).

### Files Modified

| File | Changes |
|------|---------|
| `packages/shared/src/schemas.ts` | `TelegramMessage.baseText`, `RunEnrichmentInput.sessionStartTs` |
| `packages/shared/src/store.ts` | `saveSynthesizedInsights()`, `getSynthesizedInsights()` |
| `packages/agent/src/graphs/enrichment/nodes/edit.ts` | Per-user baseText, sendMetaReply for non-resolved, saveSynthesizedInsights |
| `packages/bot/src/bot.ts` | getSynthesizedInsights carry-forward, free groups allowed, per-user baseText |
| `packages/agent/src/graphs/enrichment/nodes/synthesize.ts` | ETA pass-through (no absolute conversion) |
| `packages/agent/src/graphs/enrichment/enrichment-graph.ts` | sessionStartTs in AgentState |
| `packages/agent/src/runtime/worker.ts` | sessionStartTs passthrough |
| `packages/agent/__tests__/edit-node.test.ts` | Updated for sendMetaReply firing on red_alert, added saveSynthesizedInsights mock |

### ETA Design Decision

ETA is now **pass-through from source**: if channel says "7 minutes" → output `~7 мин`/`~7 min`/`~7 דק'`/`~7 دقائق`. If source says "~09:12" → output `~09:12`. LLM does NOT convert between relative and absolute formats. This avoids the entire class of time arithmetic bugs.

### Tests

- **257 tests** across 17 test files — 253 passed, 4 skipped (integration, need API key)

---

## Postmortem — April 7 2026 Attack (13:00) — No Metadata

### Root Cause — sendMetaReply Origin Guard Too Restrictive

**Context:** Attack at 13:00 IDT. Bot was running v2.0.1. OpenRouter primary model (gemini-flash) failed with "Insufficient credits" on all extract-channel calls → fallback model (`gpt-oss-120b:free`) used. Fallback extracted only `origin: Iran` (5 sources). No `rocket_count`, no `eta_absolute`.

**Why no metadata appeared:**
1. `editTelegramMessage` is **gated on `alertType !== "early_warning"`** — correctly by design. Since enrichment ran while session was still in early_warning phase, inline edit was skipped.
2. `sendMetaReply` guard checked `hasRocket || hasEta`. Neither was present — only `origin`. Guard returned early.
3. Result: zero Telegram actions despite successful extraction of `origin: Iran`.

**Fix (v2.0.3):** Added `hasOrigin` to `sendMetaReply` guard:
```typescript
const hasOrigin = !!get("origin")?.value.en;
if (!hasRocket && !hasEta && !hasOrigin) return;
```
Origin-only meta reply now fires: `Откуда: Иран¹²³`.

**Note:** This was also a v2.0.2 regression risk — the same logic existed. Now fixed.

---

## Resolved Phase Timing — v2.0.3

### Change: Offset-based resolved enrichment (2/10/20 min)

**Old behavior:** 3 enrichment runs for resolved, with fixed 150s interval between each. Timing was approximate and dependent on run duration.

**New behavior:** 3 runs at **absolute offsets from when resolved phase started** (`phaseStartTs`):
- Run 1: `phaseStartTs + 2 min` (120s)
- Run 2: `phaseStartTs + 10 min` (600s)
- Run 3: `phaseStartTs + 20 min` (1200s)

Worker computes `delay = max(1000ms, offset[runNum] - elapsed)` — ensures runs fire at exactly 2/10/20 min regardless of how long each run takes.

**Config (optional override):**
```yaml
ai:
  resolved_run_offsets_ms: [120000, 600000, 1200000]  # default
```

**Implementation:**
- `config.ts`: `resolved_run_offsets_ms` → `config.agent.resolvedRunOffsetsMs`
- `store.ts`: `RESOLVED_RUN_OFFSETS_MS` export
- `bot.ts`: initial resolved delay = `RESOLVED_RUN_OFFSETS_MS[0]` (was `PHASE_ENRICH_DELAY_MS.resolved`)
- `worker.ts`: resolved re-enqueue uses offset-based delay; `maxRuns` for resolved = `RESOLVED_RUN_OFFSETS_MS.length`

---

## Version History (Recent)

| Version | Date       | Changes                                                         |
| ------- | ---------- | --------------------------------------------------------------- |
| v2.0.3  | 2026-04-07 | fix: sendMetaReply fires on origin-only; resolved timing 2/10/20min offsets |
| v2.0.2  | 2026-04-07 | fix: 5 bugs from April 7 attack — ETA pass-through, language, carry-forward, meta reply, free groups |
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

1. **Every node = separate file** in `packages/agent/src/graphs/<graph-name>/nodes/`
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
├── graphs/
│   ├── enrichment/
│   │   ├── enrichment-graph.ts    # StateGraph: 5-node pipeline + AgentState
│   │   └── nodes/
│   │       ├── pre-filter.ts      # Noise filter + tracking (imports from utils/)
│   │       ├── extract.ts         # Agent opts + extractChannelNode
│   │       ├── post-filter.ts     # Area relevance + confidence validation
│   │       ├── synthesize.ts      # Voting + LLM synthesis (imports buildConsensus from utils/)
│   │       └── edit.ts            # Telegram message editing
│   └── qa/
│       ├── qa-graph.ts            # StateGraph: 3-node Q&A pipeline + QaState
│       └── nodes/
│           ├── intent.ts          # Deterministic intent classifier (0 tokens)
│           ├── context.ts         # Redis + Oref history context-gather
│           └── answer.ts          # LLM answer generation (Zod-validated)
├── index.ts              # Public API re-exports
├── models.ts             # LLM model instances + invokeWithFallback
├── utils/
│   ├── noise-filter.ts       # noiseReason(), toNewsMessage()
│   ├── tracking.ts           # buildTracking(), FilterStats
│   ├── phase-rules.ts        # getPhaseRule()
│   ├── channel-extract.ts    # extractFromChannel()
│   ├── field-key-map.ts      # fieldKeyToKind()
│   ├── consensus.ts          # buildConsensus(), groupInsightsByKind(), computeOptions()
│   ├── resolve-area.ts       # resolveArea() — 3-tier area matching
│   ├── guardrails.ts         # applyGuardrails() — max length, banned patterns, hallucination check
│   └── message.ts            # buildEnrichedMessage(), insertBeforeBlockEnd(), formatCitations()
└── runtime/
    ├── worker.ts             # BullMQ worker (config-driven max runs + DLQ logging)
    ├── queue.ts              # BullMQ queue
    ├── canary.ts             # Canary mode — synthetic alert self-test
    ├── redis.ts              # ioredis singleton
    ├── auth.ts               # GramJS auth
    └── dry-run.ts            # CLI dry-run
```

---

### Phase 3: Q&A Graph (Chat with Bot) ✅

**Status:** COMPLETED. 3-node Q&A graph + bot handler + 15 unit tests.

**What was done:**
- Created `packages/agent/src/graphs/qa/qa-graph.ts` — StateGraph: intent → context → answer
- Created 3 node files in `packages/agent/src/graphs/qa/nodes/`:
  - `intent.ts` — deterministic regex classifier (0 tokens): `current_alert`, `recent_history`, `general_security`, `bot_help`
  - `context.ts` — Redis session data + Oref history API context gathering
  - `answer.ts` — LLM answer generation with Zod-validated `{ text: LocalizedValue, sources: string[] }` output
- Created `packages/bot/src/handlers/qa.ts` — grammY handler for private messages
  - Rate limiter: 5 questions/min per user (Redis INCR + EXPIRE)
  - Typing indicator while processing
  - Error handling with user-friendly fallback message
- Created `packages/agent/__tests__/qa-graph.test.ts` — 15 tests (1 skipped without API key)
- Config additions: `ai.qa_rate_limit_per_min`, `ai.qa_model`

---

### Phase 4: Inline Mode (@easyorefbot) ✅

**Status:** COMPLETED. Inline query handler + status widget + Q&A integration.

**What was done:**
- Created `packages/bot/src/handlers/inline.ts` — inline query handler
  - Empty query → `InlineQueryResultArticle` with current alert status from Redis
  - Text query → runs Q&A graph → returns answer as article
  - Cache: 30s (`cache_time: 30`)
  - Rate limiting: shared Redis counter with Q&A
- Registered handler in `packages/bot/src/bot.ts`

---

### Phase 5: Shelter Search ✅

**Status:** COMPLETED. Pikud HaOref API integration + haversine search + bot handler + 11 unit tests.

**What was done:**
- Created `packages/shared/src/shelter.ts` — `findNearestShelters()`, `haversine()`, `fetchSheltersFromOref()`
  - Uses Pikud HaOref public API: `GET https://www.oref.org.il/Shared/Ajax/GetShelters.aspx`
  - Query params: `lat`, `long`, `radius` (meters)
  - Haversine formula for distance calculation + sorting
  - Returns: `{ name, address, lat, lng, distanceKm, googleMapsUrl }[]`
- Created `packages/bot/src/handlers/shelter.ts` — location message handler
  - `bot.on("message:location")` — extracts lat/lng, calls findNearestShelters
  - Formatted numbered list with Google Maps direction links
  - Walking time estimate (assuming 5 km/h)
  - Free feature — available to ALL tiers
- Created `packages/shared/__tests__/shelter.test.ts` — 11 unit tests
- Config additions:
  ```yaml
  shelter:
    max_distance_km: 2       # max search radius
    max_results: 5            # max shelters to return
  ```

---

### Phase 6: Monetization (Freemium) ✅

**Status:** COMPLETED. Free/pro tier separation + admin commands + 12 unit tests.

**What was done:**
- Created `packages/bot/src/middleware/tier.ts` — `requirePro()` gate middleware
- Created `packages/bot/src/handlers/admin.ts` — `/grant`, `/revoke`, `/users` admin commands
- Created `packages/bot/src/__tests__/tier.test.ts` — 12 unit tests
- Modified `packages/shared/src/schemas.ts` — `UserConfig.tier: "free" | "pro"`
- Modified `packages/bot/src/bot.ts` — tier check in alert fanout, admin handler registration
- Config addition: `admin_chat_ids: [123456789]` in YAML

| Feature                  | Free                             | Pro                                           |
| ------------------------ | -------------------------------- | --------------------------------------------- |
| Alerts (Oref → Telegram) | ✅ private msg, **ETA time only** | ✅ **chat integration** (groups)               |
| Shelter search           | ✅                                | ✅                                             |
| AI enrichment metadata   | ❌                                | ✅ full (origin, rockets, interceptions, etc.) |
| Q&A chat                 | ❌                                | ✅                                             |
| Inline Q&A               | ❌                                | ✅ (inline status widget: free)                |

---

### Phase 7: Stability Hardening ✅

**Status:** COMPLETED. Guardrails, contract tests, snapshot tests, canary mode, health v2, DLQ.

**What was done:**
- 7a: Snapshot tests — 5 golden input/output tests for extract + synthesize nodes (vitest snapshots)
- 7b: Zod contract tests — 31 tests covering all cross-package schema boundaries
- 7c: LLM guardrails — `applyGuardrails()` in `utils/guardrails.ts`: max field length (500 chars), banned patterns (AI refusals, placeholders, N/A, neuroslop), all-empty rejection. Integrated into synthesize-node. 10 tests.
- 7d: Canary mode — `canary.ts` in runtime/: synthetic `canary-*` enrichment on startup (`ai.canary: true`). Edit-node skips Telegram API for canary alerts.
- 7e: Health check v2 — `GET /health` returns 7 new fields: `last_alert_ts`, `last_enrichment_ts`, `registered_users`, `redis_connected`, `gramjs_connected`, `active_session_phase`, `agent_enabled`
- 7f: BullMQ DLQ — structured failure logging with alertId, alertTs, attempt, maxAttempts

**Tests:** 256 tests across 17 test files — all passing.

---

### Dependency Graph (all complete)

```
Phase 0 ✅ → Phase 1 ✅
  ↓
Phase 2 ✅ (Hygiene + Enrichment v2)
  ↓
  ├── Phase 3 ✅ (Q&A) ──→ Phase 4 ✅ (Inline)
  ├── Phase 5 ✅ (Shelter)
  └── Phase 6 ✅ (Monetization)
        ↓
Phase 7 ✅ (Stability)
        ↓
Phase 8 ✅ (Config + Release)
```

**All phases 0-8 complete.** v2.0.0 released.

---

### Phase 8: Config Consolidation + Release ✅

**Status:** COMPLETED. Single-instance config, /start registration, release pipeline hardened, v2.0.0 released.

**What was done:**

1. **`/start` registration handler** — `packages/bot/src/handlers/start.ts`
   - `/start [lang]` — registers user (private or group) in Redis
   - Areas default to `config.cityIds` (resolved from YAML `city_ids` via `resolveCityIds`)
   - Language defaults to `ru`, optional arg: `/start en`, `/start he`
   - Updates existing user (re-/start changes language)
   - Registered in bot before admin/shelter/qa/inline handlers

2. **`config.cityIds`** added to `packages/shared/src/config.ts`
   - YAML `city_ids` now parsed and exposed as `config.cityIds: number[]`
   - Used by `/start` handler to resolve default areas

3. **Release cooldown** — 150s sleep between `npm publish` and `npm run rpi`
   - All 3 release scripts (`release`, `release:minor`, `release:major`) updated
   - Prevents `easyoref update` on RPi from fetching stale npm CDN cache

4. **Single RPi config** — `~/.easyoref/config.yaml`
   - Bot token: `8656192726:…` (unified, was split across ru/he instances)
   - No `redis_prefix` (single instance), no `language`/`chat_id` (user-based routing)
   - `admin_chat_ids: [1929063904]`
   - Old per-language services (`easyoref-ru_tlv-south`, `easyoref-he_tlv-south`) removed
   - Old per-language configs (`config.ru_tlv-south.yaml`, `config.he_tlv-south.yaml`) deleted

### Chat Configuration (Post-Deploy)

After v2.0.0 is running on RPi, configure chats by sending `/start` in each:

| Chat | Type | /start command | Then |
|------|------|---------------|------|
| `-1002720800303` | Group | `/start ru` | `/grant -1002720800303` (from admin) |
| `1929063904` | Private | `/start ru` | `/grant 1929063904` (self, admin) |
| `-1003872506387` | Group | `/start en` | `/grant -1003872506387` (from admin) |

**Admin flow:**
1. Add bot to each group chat
2. Send `/start ru` or `/start en` in each chat (registers in Redis)
3. From admin account (1929063904): `/grant <chatId>` for each chat that needs pro features
4. Verify: `/users` shows all registered chats with correct language/tier

**Note:** Groups get pro tier via `/grant` (enrichment, Q&A). Without `/grant`, groups receive free-tier alerts only (no enrichment metadata).

---

## Postmortem — April 7 2026 Q&A Failure (13:33)

### Problem

User asked bot: "Когда была последняя азака сегодня в тель авиве? Сколько было ракет? Были ли кассетные?"
Response came **9 minutes later** with generic "no data" answer.

### LangSmith Trace (019d6826-361d-7188-8a5b-1e738f80e606)

| Node | Start | End | Duration | Issue |
|------|-------|-----|----------|-------|
| `intent-classify` | 13:33:48.028 | 13:33:48.039 | 11ms | ✅ OK — classified `current_alert` |
| `context-gather` | 13:33:48.046 | 13:33:48.057 | 11ms | ❌ Returned `"No active alert at the moment."` only |
| `answer-generate` | 13:33:48.062 | 13:42:43.673 | **8min 55s** | ❌ `withStructuredOutput()` hung → fallback after timeout |

- `ChatOpenRouterStructuredOutput` (13:33:48 → 13:42:39): 8m52s → `TypeError: terminated` (connection abort)
- `ChatOpenRouter` fallback (13:42:39 → 13:42:43): 4s → generated "no data" response (correct given empty context)

### Root Causes (2 bugs)

**Bug #1: Context node too shallow**
- Old `contextNode` only checked `getActiveSession()` — if no active session → returned 1 sentence `"No active alert at the moment."`
- Did NOT check: Oref history API, GramJS channel posts in Redis, enrichment cache
- Result: LLM given zero data → correctly said "no data"

**Bug #2: No timeout on LLM calls**
- `withStructuredOutput()` on `openai/gpt-oss-120b` has no timeout
- OpenRouter hung for 8m52s before TCP connection was terminated by the client
- No `AbortSignal.timeout()` was used → unbounded wait

### Fixes (v2.0.4)

| Fix | File | Change |
|-----|------|--------|
| Context: 5 data sources | `context.ts` | Rewrote to fetch: active session + enrichment cache + current Oref API + Oref history + channel posts from Redis |
| Context: status callbacks | `context.ts` | Sends "🔎 Checking alerts..." / "🔎 Searching history..." status messages via `statusCallback` |
| Context: off_topic guard | `context.ts` + `intent.ts` | New `off_topic` intent — polite rejection for non-security questions |
| Answer: 30s timeout | `answer.ts` | `AbortSignal.timeout(30_000)` on both structured output and fallback LLM calls |
| Answer: [[channel]](url) citations | `answer.ts` | System prompt instructs LLM to use `[[channel_name]](url)` format |
| Bot: typing indicator loop | `qa.ts` | Sends typing action every 4s while processing |
| Bot: group chat support | `qa.ts` | Q&A works in groups when bot is @mentioned or replied to |
| Inline: link preview disabled | `inline.ts` | `link_preview_options: { is_disabled: true }` in Q&A answers |
| Enrichment: emoji keys | `message.ts` + `edit.ts` | Replaced `<b>Key:</b>` with emoji-prefixed keys (⏱🌍🚀🛡💥🏥) |
| Enrichment: no blockquote | `message.ts` | Removed `<blockquote>` wrapping for all phases — plain text enrichment lines |
| Intent: broader patterns | `intent.ts` | Added `history|yesterday|happened|вчера|прошл|истори|было|произош|אתמול|שבוע` to SECURITY_PATTERNS |

### Tests

- **258 tests** across 17 test files — 254 passed, 4 skipped (integration, need API key)
