---
name: rpi-enrichment-logs
description: "Check RPi systemd logs for EasyOref enrichment pipeline issues. Use when: duplicate alerts, cooldown failures, session state bugs, phase transitions wrong, Telegram send errors, GramJS connection issues, worker crashes. Requires SSH to RPi."
argument-hint: "Describe the enrichment issue and approximate time (e.g., 'duplicate red_alert at 18:18 IDT')"
---

# RPi Enrichment Logs — systemd Investigation

Check RPi journalctl logs for EasyOref enrichment pipeline issues that are NOT visible in LangSmith.

## When to Use

- Duplicate alerts sent to users
- Cooldown not blocking repeated alerts
- Session phase transitions wrong (e.g., `red_alert → red_alert`)
- Telegram send failures
- GramJS disconnections or edited message handling
- Worker crashes or DLQ entries
- Enrichment never started (no LangSmith traces at all)

## What's NOT in LangSmith

LangSmith only traces the LangGraph pipeline execution. These happen OUTSIDE the graph:

- Alert detection, cooldown checks, Telegram sends → `bot.ts`
- Session creation, phase upgrades → `bot.ts`
- BullMQ job scheduling, worker lifecycle → `worker.ts`
- GramJS post collection, channel monitoring → `gramjs/index.ts`
- Health checks, config loading → `service.ts`, `config.ts`

## Procedure

### Step 1: SSH and Fetch Logs

```bash
# Recent 200 lines (overview)
ssh pi@raspberrypi.local "journalctl -u easyoref -n 200 --no-pager"

# Time-range query (use IDT = UTC+3)
ssh pi@raspberrypi.local "journalctl -u easyoref --since='2026-04-09 22:00' --until='2026-04-09 23:00' --no-pager"

# Errors only
ssh pi@raspberrypi.local "journalctl -u easyoref -p err -n 50 --no-pager"
```

**IMPORTANT:** RPi logs use IDT (Israel Daylight Time, UTC+3). LangSmith uses UTC. Convert accordingly.

### Step 2: Filter by Pipeline Stage

#### Alert Detection & Sending

```bash
ssh pi@raspberrypi.local "journalctl -u easyoref --since='2026-04-09 22:00' --no-pager" | grep -iE 'Alert.*RELEVANT|Alert sent|Cooldown active|Alert type filtered|no users matched'
```

**Key log messages:**

- `"Alert — RELEVANT"` → alert passed filters, `matched_users` shows who receives it
- `"Alert sent via Telegram (text)"` → successful send, `type`, `chatId`
- `"Cooldown active, skipping Telegram"` → duplicate suppressed
- `"Alert — no users matched area"` → nobody subscribed to those areas

#### Session Lifecycle

```bash
ssh pi@raspberrypi.local "journalctl -u easyoref --since='2026-04-09 22:00' --no-pager" | grep -iE 'Session:|resolved phase|upgraded phase|without active session'
```

**Key log messages:**

- `"Session: started"` → new session, `phase`, `chatCount`
- `"Session: upgraded phase"` → `from` → `to` (e.g., `early_warning → red_alert`)
- `"Session: entered resolved phase"` → all-clear
- `"Resolved alert without active session — no enrichment"` → resolved with no session

#### Worker & BullMQ

```bash
ssh pi@raspberrypi.local "journalctl -u easyoref --since='2026-04-09 22:00' --no-pager" | grep -iE 'Enrich worker:|job FAILED|DLQ'
```

**Key log messages:**

- `"Enrich worker: starting run"` → `alertId`, `phase`, `runNum`, `maxRuns`
- `"Enrich worker: max runs reached"` → session complete
- `"Enrich worker: no active session — skipping"` → session expired before job ran
- `"Enrich worker: phase expired"` → timeout before completion
- `"Enrich worker: job FAILED → DLQ"` → crash with `error`, `stack`

#### GramJS Channel Monitoring

```bash
ssh pi@raspberrypi.local "journalctl -u easyoref --since='2026-04-09 22:00' --no-pager" | grep -iE 'gramjs|channel|stored.*post|EditedMessage'
```

### Step 3: Diagnose Common Issues

#### Duplicate Alerts

Look for two `"Alert sent"` with same `type` within 90s:

```bash
ssh pi@raspberrypi.local "journalctl -u easyoref --since='2026-04-09 22:00' --no-pager" | grep 'Alert sent' | head -20
```

- Check `"Cooldown state restored from Redis"` at startup — if missing, cooldown was lost
- Check for PID change (process restart mid-attack) → resets in-memory state

#### Process Restart During Attack

```bash
ssh pi@raspberrypi.local "journalctl -u easyoref --since='2026-04-09 22:00' --no-pager" | grep -iE 'EasyOref starting|Bot initialized|pid'
```

Multiple `"EasyOref starting"` entries = restart. Check if `npm run release` or `easyoref update` triggered mid-attack.

#### Enrichment Never Started

If no LangSmith traces exist:

1. Check `"Session: started"` — was a session created?
2. Check `"Enrich worker started"` — is the worker alive?
3. Check for BullMQ errors or Redis connection issues
4. Check `"Alert type filtered out by config"` — is `early_warning` enabled?

#### Telegram API Errors

```bash
ssh pi@raspberrypi.local "journalctl -u easyoref --since='2026-04-09 22:00' --no-pager" | grep -iE 'Telegram.*failed|Telegram unavailable|send failed'
```

- `"Telegram send failed"` → API error, check `error` field (rate limit, chat not found, etc.)
- `"Telegram unavailable"` → bot instance or chatId missing

### Step 4: Build Timeline

Combine logs into a chronological timeline:

| Time (IDT) | Event                | Details                      |
| ---------- | -------------------- | ---------------------------- |
| 22:14:28   | early_warning sent   | 3 chats                      |
| 22:14:28   | Session started      | phase=early_warning          |
| 22:16:02   | red_alert sent       | 3 chats                      |
| 22:16:02   | Session upgraded     | early_warning → red_alert    |
| 22:16:30   | Enrich worker run #1 | alertId=..., phase=red_alert |
| 22:18:00   | Enrich worker run #2 | alertId=...                  |
| 22:24:30   | resolved sent        | 3 chats                      |

Cross-reference with LangSmith traces (use `attack-postmortem` skill for that).

## Service Management

```bash
# Check service status
ssh pi@raspberrypi.local "systemctl status easyoref"

# Restart service
ssh pi@raspberrypi.local "sudo systemctl restart easyoref"

# Check current version
ssh pi@raspberrypi.local "easyoref --version"

# Check Redis
ssh pi@raspberrypi.local "docker exec -it \$(docker ps -q -f name=redis) redis-cli ping"
```

## Tips

- Logs are in JSON format (pino). Use `| jq .` for pretty-printing if needed
- PID changes in logs indicate process restarts — correlate with deploy times
- `journalctl --since` uses local time (IDT). No need to convert to UTC
- For large log volumes, pipe through `grep` before `--no-pager` to reduce output
- Max useful window: `journalctl` retains ~7 days on RPi (depends on disk space)
