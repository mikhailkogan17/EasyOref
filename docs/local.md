# Local Development

## Prerequisites

- Node.js 22+
- Telegram bot token (from [@BotFather](https://t.me/BotFather))

## Setup

```bash
cd ~/EasyOref
npm install
```

## Running

### npx (recommended)

```bash
npx easyoref init   # interactive setup wizard → saves ~/.easyoref/config.yaml
npx easyoref        # start the bot
```

### tsx watch (hot-reload for dev)

```bash
npx tsx watch packages/bot/src/bot.ts
```

Requires `~/.easyoref/config.yaml` or `./config.yaml` to exist.

### Docker Compose

```bash
# Create config.yaml in project root (see config.yaml.example)
docker compose up -d
curl http://localhost:3100/health
docker compose logs -f
```

## VS Code

Open the workspace file:

```bash
code easyoref.code-workspace
```

Tasks:
- **Dev: Watch** — `npx tsx watch src/bot.ts`
- **Docker: Up** — `docker compose up -d`

## Tests

```bash
npm test            # run once
npm run test:watch  # watch mode
```
