# Local Development

## Prerequisites

- Node.js 22+
- Git (to clone repo)
- Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Redis (for enrichment pipeline)

## Setup

```bash
git clone https://github.com/mikhailkogan17/EasyOref.git
cd EasyOref
npm install
```

Install Redis:
- **macOS:** `brew install redis`
- **Linux:** `sudo apt install redis-server && sudo systemctl start redis-server`
- **Docker:** `docker run -d -p 6379:6379 redis:7-alpine`

## Running

### Option 1: npm scripts (monorepo)

```bash
# Initialize config
npm run -- --workspace=packages/bot easyoref init

# Run bot
npm run dev
```

Or directly:
```bash
npx easyoref init   # creates ~/.easyoref/config.yaml
npx easyoref        # start bot
```

### Option 2: Hot-reload (for active development)

```bash
npx tsx watch packages/bot/src/bot.ts
```

Requires `~/.easyoref/config.yaml` to exist.

### Option 3: Docker Compose

```bash
# Copy and edit config
cp config.yaml.example config.yaml
nano config.yaml

# Start all services (Redis + Bot)
docker compose up -d
curl http://localhost:3100/health
docker compose logs -f easyoref
```

## VS Code

```bash
code easyoref.code-workspace
```

Pre-configured tasks:
- **Dev: Watch** → Hot-reload bot with tsx
- **Docker: Up** → Start all containers

## Testing

```bash
# Unit tests
npm test

# Watch mode
npm run test:watch

# With LLM integration (requires OPENROUTER_API_KEY)
OPENROUTER_API_KEY="sk-or-v1-..." npm test
```

## Building

```bash
# Build all packages
npm run build

# Build specific package
npm run build --workspace=packages/bot
```

## Debugging

### Check if bot is working

```bash
# Logs should show:
# - GramJS connecting to Telegram
# - Agent subsystems started
# - Channels being monitored

easyoref logs
```

### Check Redis

```bash
redis-cli ping       # should return PONG
redis-cli info       # show stats
```

### Manual run (debug mode)

```bash
easyoref stop  # if running as service
easyoref run   # foreground, full errors
# Ctrl+C to stop
```

## Release & Deploy

```bash
npm run release         # Patch: 1.22.0 → 1.22.1
npm run release:minor   # Minor: 1.22.0 → 1.23.0
npm run release:major   # Major: 1.22.0 → 2.0.0
```

See [AGENTS.md](../AGENTS.md) for full workflow.
