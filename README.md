# EasyOref

Real-time Israeli civil defense alerts → your family's Telegram chat.
Configure once, deploy, forget.

[![CI](https://github.com/mikhailkogan17/EasyOref/actions/workflows/ci.yml/badge.svg)](https://github.com/mikhailkogan17/EasyOref/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![npm](https://img.shields.io/badge/npm-easyoref-CB3837?logo=npm)](https://www.npmjs.com/package/easyoref)
[![Docker](https://img.shields.io/badge/ghcr.io-easyoref-2496ED?logo=docker)](https://ghcr.io/mikhailkogan17/easyoref)

[Русский](docs/readme_ru.md) · [עברית](docs/readme_he.md)

> [!CAUTION]
> EasyOref **does not replace** official Home Front Command alerts, the [Pikud HaOref app](https://www.oref.org.il/eng), or [Tzofar](https://www.tzofar.com/).
> It **supplements** them — notifying your family abroad about your safety.
> Always follow IDF Home Front Command instructions.

---

## Why

During rocket attacks, your family abroad sees "MISSILES HIT TEL AVIV" on the news. They don't know:

- Is it your neighborhood or 200 km away?
- Are you safe right now?
- Should they call? (you're in a shelter with no hands free)

**There's no existing bot that solves this.** Red Alert apps are for *you* in Israel.
Your parents in Moscow / Kyiv / Berlin need something different — automatic, filtered, in their language.

**EasyOref fills the gap:** your family gets real-time updates without you lifting a finger.

---

## How it works

```
Oref API (poll every 2s)
  → Filter: is this alert in MY area?
    → Classify: early warning / siren / all-clear
      → Cooldown: don't spam (2 min / 90s / 5 min)
        → Translate to ru/en/he/ar
          → Send to Telegram (with optional GIF)
```

No AI, no cloud dependencies, no accounts. Pure deterministic filtering. Sub-second latency.

---

## Features

- **Area filtering** — only alerts for your city, not the entire country
- **4 languages** — Russian, English, Hebrew, Arabic (auto-translated area names)
- **3 alert types** — early warning, siren, incident over (configurable)
- **GIF modes** — `funny_cats` / `assertive` / `none` (reduces panic for families)
- **Custom messages** — override any title or description per alert type
- **Night mode** — calmer GIFs at 3–11 AM Israel time
- **Persistent state** — GIF rotation survives container restarts
- **Health endpoint** — `/health` for uptime monitoring
- **Better Stack** — optional structured logging via Logtail

---

## Quick Start

**You need:** Docker, a Telegram bot token, your chat ID.

### Step 1: Create a Telegram bot

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token
2. Add the bot to your family group chat
3. Forward any message from that chat to [@userinfobot](https://t.me/userinfobot) → copy the chat ID

### Step 2: Find your city ID

Open [cities.json](https://raw.githubusercontent.com/eladnava/pikud-haoref-api/master/cities.json) and search for your city name. Copy the `id` number.

Example: `"id": 722` = Tel Aviv — South & Jaffa.

### Step 3: Deploy

```bash
git clone https://github.com/mikhailkogan17/easyoref.git
cd easyoref
cp config.yaml.example config.yaml
```

Edit `config.yaml`:

```yaml
# Your city (find ID in Step 2)
city_ids:
  - 722

# Message language: ru / en / he / ar
language: ru

# Telegram credentials (from Step 1)
telegram:
  bot_token: "paste-token-here"
  chat_id: "-1001234567890"
```

Run:

```bash
docker compose up -d
```

Verify:

```bash
curl localhost:3100/health
```

**That's it.** The bot watches Oref API and messages your family chat on every relevant alert.

---

## Configuration

All settings live in [`config.yaml`](config.yaml.example).

### Required

| Key | What it is |
| --- | --- |
| `city_ids` | Cities to monitor ([find IDs here](https://raw.githubusercontent.com/eladnava/pikud-haoref-api/master/cities.json)) |
| `telegram.bot_token` | Token from @BotFather |
| `telegram.chat_id` | Your group chat ID (negative number) |

### Optional

| Key | Default | What it does |
| --- | --- | --- |
| `language` | `ru` | Message language: `ru` `en` `he` `ar` |
| `alert_types` | all | Which alerts to forward: `early` `siren` `incident_over` |
| `gif_mode` | `none` | Attach GIF to messages: `funny_cats` `assertive` `none` |
| `title_override.*` | — | Custom title per alert type |
| `description_override.*` | — | Custom description per alert type |
| `observability.betterstack_token` | — | [Better Stack](docs/MONITORING.md) logging |

<details>
<summary>Advanced options</summary>

| Key | Default | What it does |
| --- | --- | --- |
| `health_port` | `3100` | Health endpoint port |
| `poll_interval_ms` | `2000` | API poll interval (ms) |
| `data_dir` | `./data` | Persistent state directory |
| `oref_api_url` | Oref default | Custom API endpoint |

</details>

---

## Alternative installs

**npm (global):**
```bash
npm install -g easyoref
easyoref  # reads config.yaml from cwd
```

**From source (Node.js 22+):**
```bash
npm install && npm run build && npm start
```

---

## Project structure

```
packages/
  bot/       — Telegram bot (npm: easyoref)
    src/
      bot.ts       — polling, Telegram, GIF pools
      config.ts    — YAML config + env fallback
      i18n.ts      — 4-lang templates + area translation
      gif-state.ts — persistent GIF rotation
      logger.ts    — console + Logtail logger
  cli/       — setup wizard (npx @easyoref/cli init)
```

---

## FAQ

**Can I monitor multiple areas?**
`city_ids: [722, 723, 1]`

**Why cats?**
A cute cat next to "stay near shelter" = "I'm fine, it's handled." Plain text "SIREN IN TEL AVIV" makes families panic more.

**GIF rotation resets on redeploy?**
No — persisted in a Docker named volume.

**Why Russian by default?**
Built for Russian-speaking diaspora. Set `language: en` to change.

---

## Contributing

PRs welcome.

- [ ] `/test` command for manual trigger
- [ ] Prometheus metrics (`/metrics`)
- [ ] Web dashboard (alert history)

---

## License

[MIT](LICENSE) — Mikhail Kogan, 2025–2026
