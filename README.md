# EasyOref

> **Peace-of-mind bot for families during wartime.**
> Real-time Israeli Civil Defense alerts to Telegram, filtered by your location.

> ⚠️ **Disclaimer:** EasyOref supplements but does not replace official Home Front Command (Pikud HaOref) alerts. Always follow official instructions.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker)](Dockerfile)

[English](#what-it-does) | [Русский](#что-делает)

---

## What it does

- Polls [Pikud HaOref API](https://www.oref.org.il/) every 2 seconds for active alerts
- Filters by **your region** (e.g. Tel Aviv South, Gush Dan, Jerusalem)
- Sends **calm, context-aware messages** to your family Telegram chat:
  - 🚀 **Early warning** (5–12 min): "Rocket launches detected, I'm aware"
  - 🚨 **Siren** (1.5 min): "I'm in shelter, all good"
  - 😮‍💨 **Incident over**: "Back to normal"
- Cooldown logic (no spam): 30 min for early warnings, 1.5 min for sirens
- Night mode (03:00–11:00 Israel time): different GIFs to reduce panic
- **3 languages**: Russian, English, Hebrew

## Why it exists

For **diaspora families** who see "Tel Aviv under attack" on CNN but don't know:
- Is it your area or 200 km away?
- Are you safe?
- Should they call/text (while you're in a shelter)?

**EasyOref solves information asymmetry**: your family gets automated updates **without you doing anything**.

### Why GIFs with cats?

Reduces panic. Seeing a cute cat = signal "everything is under control" (vs plain text "SIREN IN TEL AVIV").

---

## Quick Start (Docker — recommended)

**Requirements**: Docker + Telegram bot token

```bash
# 1. Create bot via @BotFather → get BOT_TOKEN
# 2. Add bot to your family group chat → get CHAT_ID
#    (forward a message from the group to @userinfobot)

# 3. Clone and configure
git clone https://github.com/mikhailkogan17/easyoref.git
cd easyoref
cp .env.example .env
# Edit .env with your values

# 4. Run
docker compose up -d

# 5. Check health
curl localhost:3100/health
```

**Done!** Bot is now monitoring Oref API and will message your chat on alerts.

### `.env` example

```bash
BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
CHAT_ID=-1001234567890
AREAS=תל אביב - דרום העיר ויפו,גוש דן
LANGUAGE=ru
```

---

## Run without Docker

```bash
# Requirements: Node.js 22+
npm ci
npm run build
npm start
```

Or for development with hot-reload:

```bash
npm run dev
```

---

## Configuration

### Required (via `.env` or environment variables)

| Variable    | Description                            | Example                           |
| ----------- | -------------------------------------- | --------------------------------- |
| `BOT_TOKEN` | Telegram bot token from @BotFather     | `123456:ABC-DEF...`               |
| `CHAT_ID`   | Telegram chat ID (negative for groups) | `-1001234567890`                  |
| `AREAS`     | Comma-separated Hebrew area names      | `תל אביב - דרום העיר ויפו,גוש דן` |

### Optional

| Variable                | Default | Description                                  |
| ----------------------- | ------- | -------------------------------------------- |
| `LANGUAGE`              | `ru`    | Message language: `ru` / `en` / `he`         |
| `HEALTH_PORT`           | `3100`  | Health endpoint port                         |
| `OREF_POLL_INTERVAL_MS` | `2000`  | API poll interval (ms)                       |
| `LOGTAIL_TOKEN`         | —       | Better Stack Logtail token for cloud logging |

### Finding your area name

Area names must be in Hebrew exactly as Oref API returns them. See [areas.json](areas.json) for common areas with English translations.

---

## Architecture

```
Oref API (2-sec poll)
  → Area filter (Hebrew names from AREAS env)
    → Alert type classifier (early_warning / siren / resolved)
      → Cooldown logic (30 min / 1.5 min)
        → Telegram (grammY + GIF rotation)
```

**No LLM needed** — purely deterministic matching for <1s latency.

**Production-grade:**
- Docker secrets support (`/run/secrets/bot_token`)
- Health endpoint (`/health`)
- Graceful shutdown (SIGTERM)
- Structured logging (Logtail-compatible)
- Telegram fallback (GIF → text if upload fails)
- Night mode (different GIF pool 03:00–11:00)

### Project structure

```
src/
  bot.ts      — main polling loop, Telegram integration, GIF pools
  config.ts   — centralized configuration from env vars
  i18n.ts     — message templates (ru/en/he)
  logger.ts   — dual console + Logtail logger
```

---

## FAQ

**Q: Why not use RedAlert app?**
A: RedAlert is for *you* (in Israel). EasyOref is for *your family abroad* who don't read Hebrew and panic from news.

**Q: Why Russian by default?**
A: Built for diaspora parents in Russia/Ukraine/etc. Set `LANGUAGE=en` or `LANGUAGE=he` to change.

**Q: Can I monitor multiple areas?**
A: Yes — comma-separate them in `AREAS`: `AREAS=ירושלים,חיפה - מערב,אשדוד - א,ב,ד,ה`

**Q: Can I use it for other countries?**
A: Not out of the box (hardcoded to Oref API), but the architecture is reusable — fork and adapt the polling logic.

---

## Contributing

PRs welcome! Ideas:

- [ ] More complete areas list
- [ ] `/test` command for manual trigger
- [ ] Custom GIF pools via env vars
- [ ] Prometheus metrics (`/metrics`)
- [ ] Web dashboard (recent alerts history)
- [ ] CLI wizard (`npx @easyoref/cli init`)

---

## Русский

### Что делает

- Каждые 2 секунды проверяет [API Пикуд ха-Ореф](https://www.oref.org.il/)
- Фильтрует по вашему региону (например, Тель-Авив юг, Гуш Дан)
- Отправляет **спокойные сообщения** в семейный чат Telegram:
  - 🚀 **Раннее предупреждение** (5–12 мин): "Зафиксированы запуски ракет, я в курсе"
  - 🚨 **Сирена** (1.5 мин): "Я в укрытии, всё под контролем"
  - 😮‍💨 **Инцидент завершён**: "Больше не нужно быть в укрытии"
- Cooldown (без спама): 30 мин для предупреждений, 1.5 мин для сирен
- Ночной режим (03:00–11:00): другие GIF'ки

### Зачем это нужно

Для **семей за границей**, которые видят "Ракеты по Тель-Авиву" в новостях, но не знают:
- Это ваш район или за 200 км?
- Вы в безопасности?
- Звонить/писать (пока вы в укрытии)?

**EasyOref решает проблему**: семья получает обновления **автоматически**, вы ничего не делаете.

### Быстрый старт

```bash
# 1. Создайте бота через @BotFather → получите BOT_TOKEN
# 2. Добавьте бота в семейный чат → получите CHAT_ID
#    (перешлите сообщение из группы в @userinfobot)

# 3. Клонируйте и настройте
git clone https://github.com/mikhailkogan17/easyoref.git
cd easyoref
cp .env.example .env
# Отредактируйте .env — укажите свои значения

# 4. Запустите
docker compose up -d

# 5. Проверьте
curl localhost:3100/health
```

### Настройка `.env`

```bash
BOT_TOKEN=ваш_токен_от_botfather
CHAT_ID=-1001234567890
AREAS=תל אביב - דרום העיר ויפו,גוש דן
LANGUAGE=ru
```

Полный список районов с переводами: [areas.json](areas.json)

---

## License

[MIT](LICENSE) — Mikhail Kogan, 2025–2026
