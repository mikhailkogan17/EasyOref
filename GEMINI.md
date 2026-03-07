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

### Files

| File                          | Purpose                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| `src/agent/types.ts`          | Shared types: `AgentState`, `EnrichResult`, `ChannelMessage`                           |
| `src/agent/redis.ts`          | ioredis singleton, lazy connect                                                        |
| `src/agent/store.ts`          | Redis-backed store: alert metadata, channel messages, dedup                            |
| `src/agent/queue.ts`          | BullMQ queue: `enrich-alert` jobs with 90s delay                                       |
| `src/agent/worker.ts`         | BullMQ worker: pulls from queue → runs graph → edits message                           |
| `src/agent/graph.ts`          | LangGraph StateGraph: 5-tier pipeline (pre-filter → vote → enrich → format → validate) |
| `src/agent/gramjs-monitor.ts` | GramJS MTProto client: monitors channels, stores messages in Redis                     |
| `src/agent/auth.ts`           | One-time QR login script to obtain `session_string`                                    |
| `src/agent/dry-run.ts`        | Manual test script for the pipeline                                                    |

### Model

- **gpt-5-mini** (OpenAI, successor to gpt-4o-mini as of March 2026)
- Configured in `config.yaml` under `agent.model`

### Config Keys (config.yaml)

```yaml
agent:
  openai_api_key: "sk-..."
  session_string: "1AgAOMTQ5..."
  model: "gpt-5-mini"
  enrich_delay_ms: 90000
  channels:
    - "@newsflashhhj"
    - "@yediotnews25"
    - "@Trueisrael"
    - "@israelsecurity"
    - "@N12LIVE"
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

- Standard CI/CD: PR → merge → changesets version PR → merge → release.yml builds Docker (linux/amd64 + arm64) → pushes to ghcr.io
- ghcr.io package is **public** — RPi pulls without auth
- RPi: `docker-compose pull easyoref && docker-compose up -d`

### ЗАПРЕЩЕНО

- ❌ Предлагать ручной деплой на RPi (только через CI/CD pipeline)
- ❌ Создавать api_id/api_hash на my.telegram.org — используются публичные Telegram Desktop
- ❌ Писать `redis://localhost:6379` в Docker — только `redis://redis:6379`
- ❌ Удалять `.gitleaks.toml` allowlist — apiHash fingerprint нужен для прохождения CI
