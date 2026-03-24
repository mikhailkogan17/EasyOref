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

### Model

- **google/gemini-3-flash-preview** via OpenRouter (no RPD limits)
- Configured in `config.yaml` under `ai.openrouter_model`
- Base URL `https://openrouter.ai/api/v1` hardcoded in `graph.ts` — NOT configurable

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
  openrouter_model: "google/gemini-3-flash-preview"
  enrich_delay_ms: 20000
  confidence_threshold: 0.65
  mtproto:
    api_id: 2040
    api_hash: "b18441a1ff607e10a989891a5462e627"
    session_string: "1AgAOMTQ5..."
  redis_url: "redis://redis:6379"   # Docker network hostname, NOT localhost
```

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

- CI/CD: PR → merge → changesets version PR → merge → release.yml → npm publish (OIDC) + Docker push (ghcr.io, amd64+arm64)
- **RPi production**: npm global install + systemd (homebridge-паттерн)
  ```bash
  sudo npm install -g easyoref   # install / update
  easyoref install                # create systemd service (first time)
  easyoref restart                # after update
  ```
- Config: `~/.easyoref/config.yaml` (created by `easyoref init`)
- Redis: native `redis-server` (apt), NOT Docker
- Logs: `easyoref logs` / `journalctl -u easyoref -f`
- Docker image exists for `docker compose` local dev / CI only

### ЗАПРЕЩЕНО (Lethal Laws)

- ❌ **Клонировать git-репозиторий на RPi** — на RPi нет и не должно быть git clone. Деплой ТОЛЬКО через `npm install -g easyoref`
- ❌ **Вызывать `docker compose` / `docker-compose` для деплоя на RPi** — production RPi работает через systemd, НЕ через Docker. Docker compose — только для локальной разработки
- ❌ **Предлагать `docker compose up/down/pull` как способ обновления** — обновление: `sudo npm update -g easyoref && easyoref restart`
- ❌ Предлагать ручной деплой на RPi (только через npm + systemd)
- ❌ Создавать api_id/api_hash на my.telegram.org — используются публичные Telegram Desktop
- ❌ Писать `redis://redis:6379` в systemd/native конфиге — только `redis://localhost:6379` (Docker hostname не существует вне Docker network)
- ❌ Удалять `.gitleaks.toml` allowlist — apiHash fingerprint нужен для прохождения CI

---

## Release & Deploy Pipeline (Manual Only)

### Overview

Release is **manual-only** via `workflow_dispatch`. There is NO automatic release on push to main.

```
feature branch → PR → CI passes → merge to main
                                        │
                          (manually) gh workflow run release.yml
                                        │
                                  check-publish:
                                  LOCAL_VER vs npm view
                                        │ (if different)
                                  ┌─────┴──────────────────────┐
                                  │ npm publish --provenance    │  OIDC
                                  │ GitHub Release + tag        │
                                  │ Docker build+push (ghcr.io) │  amd64+arm64
                                  └────────────────────────────┘
                                        │
                                  RPi: npm update + restart
```

### Post-Implementation Checklist (MANDATORY)

After every fix, feature, or refactor — **always** execute the full pipeline:

1. **Version bump** — create changeset + apply it:
   ```bash
   npx changeset               # select patch / minor / major
   npx changeset version       # bumps package.json + CHANGELOG.md
   ```
2. **Commit** — all changed files (code + version bump + CHANGELOG):
   ```bash
   git add -A && git commit -m "feat/fix: description"
   ```
3. **Push + PR** — push branch, create PR, wait for CI (`ci` status check):
   ```bash
   git push -u origin <branch>
   gh pr create --title "..." --body "..."
   ```
4. **Merge** — squash merge after CI passes:
   ```bash
   gh pr merge <number> --squash --auto
   ```
5. **Trigger release** — manually run release.yml on main:
   ```bash
   gh workflow run release.yml --ref main
   gh run list --workflow=release.yml -L1   # monitor
   gh run view <run-id> --log               # check logs
   ```
6. **RPi update** — see detailed algorithm below

### RPi Update Algorithm (Step-by-Step)

**Host:** `raspberrypi.local` | **User:** `pi` | **Password:** `Darwin1809`

```bash
# 1. SSH into RPi
ssh pi@raspberrypi.local

# 2. Check current version BEFORE update
easyoref --version

# 3. Update the global npm package
sudo npm update -g easyoref

# 4. Verify new version installed
easyoref --version
# Expected: should match the version you just published (e.g. 1.18.1)

# 5. Restart the systemd service
easyoref restart

# 6. Wait 5 seconds, then check service status
sleep 5
systemctl status easyoref
# Expected: "active (running)"

# 7. Check logs for healthy startup
easyoref logs | head -30
# Expected lines:
#   "Bot initialized"
#   "MTProto connected"
#   "GramJS monitor started"
#   No errors / no crash loops

# 8. Health check via bot command (if /health exists)
# Or verify by sending test alert or checking Telegram bot responds

# 9. If version didn't update (npm cache issue):
sudo npm cache clean --force
sudo npm update -g easyoref
easyoref restart
```

**Troubleshooting RPi:**

| Symptom | Cause | Fix |
|---|---|---|
| `easyoref --version` shows old version | npm cache | `sudo npm cache clean --force && sudo npm update -g easyoref` |
| `systemctl status easyoref` → failed | Config breaking change | `easyoref logs` → check error, fix `~/.easyoref/config.yaml` |
| `easyoref restart` → "not found" | npm global bin not in PATH | `export PATH=$PATH:$(npm -g bin)` or reinstall with `sudo npm i -g easyoref` |
| MTProto not connecting | session_string expired | Re-auth: `npx easyoref auth` or update session in config.yaml |
| Redis connection refused | redis-server not running | `sudo systemctl start redis-server` |

### General Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| release.yml failed | Duplicate tag (manual `git tag` before CI) | Delete tag: `git push origin :refs/tags/vX.Y.Z`, re-run workflow |
| npm 403 | OIDC token issue | Check trusted publisher on npmjs.com |
| npm "already published" | CI already published on previous run | OK, skip |
| Docker image not found | Release failed at Docker step | Re-run release workflow on GitHub |

### CRITICAL RULES

- **NEVER** run `npm publish` locally — CI does it via OIDC
- **NEVER** run `git tag` manually before merge — CI creates tags via GitHub Release
- **NEVER** run `docker build` locally for production — CI builds multi-arch
- Manual `git tag` BEFORE merge causes tag conflict → failed release
- RPi deploy is ALWAYS via `npm update -g` + systemd, NEVER via Docker or git clone
