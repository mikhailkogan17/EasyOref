---
name: rpi-qa-logs
description: "Check RPi systemd logs for EasyOref Q&A pipeline issues. Use when: bot didn't reply to question, Q&A rate limited, typing indicator stuck, group mention not detected, inline query failed. Requires SSH to RPi."
argument-hint: "Describe the Q&A issue and approximate time (e.g., 'bot ignored question in group at 13:30')"
---

# RPi Q&A Logs — systemd Investigation

Check RPi journalctl logs for EasyOref Q&A issues that are NOT visible in LangSmith.

## When to Use

- Bot didn't reply to a user question at all (no LangSmith trace either)
- Rate limiter blocked the question
- Typing indicator sent but no answer followed
- Group chat: bot didn't detect @mention or reply-to
- Inline query returned no results
- Q&A error logged but details unclear from LangSmith alone

## What's NOT in LangSmith

LangSmith traces the Q&A LangGraph pipeline (intent → context → answer). These happen OUTSIDE:

- Rate limit checks → `qa.ts` handler
- Typing indicator loops → `qa.ts` handler
- Group @mention detection → `qa.ts` handler
- Inline query handling → `inline.ts` handler
- Error messages sent to user → `qa.ts` handler
- Tier checks (free vs pro) → `tier.ts` middleware

## Procedure

### Step 1: Fetch Q&A-Related Logs

```bash
# All Q&A related entries
ssh pi@raspberrypi.local "journalctl -u easyoref --since='2026-04-09 13:00' --until='2026-04-09 14:00' --no-pager" | grep -iE 'Q&A|qa|answer|intent|inline|rate.?limit'

# Errors only
ssh pi@raspberrypi.local "journalctl -u easyoref -p err --since='2026-04-09 13:00' --no-pager" | grep -iE 'Q&A|qa'
```

### Step 2: Check if Question Was Received

```bash
ssh pi@raspberrypi.local "journalctl -u easyoref --since='2026-04-09 13:00' --no-pager" | grep -iE 'message.*text|update.*received'
```

If the question never appears in logs:

- Bot wasn't added to the group
- Bot doesn't have message permissions
- Network issue between Telegram API and RPi

### Step 3: Diagnose Specific Failures

#### Rate Limited

The Q&A handler has a rate limiter: 5 questions per minute per chatId (Redis INCR + EXPIRE).

If rate limited, the user gets no response and no error message. Check:

```bash
ssh pi@raspberrypi.local "journalctl -u easyoref --since='2026-04-09 13:00' --no-pager" | grep -i 'rate'
```

#### Tier Check Failed

Free-tier users don't have Q&A access. Check:

```bash
ssh pi@raspberrypi.local "journalctl -u easyoref --since='2026-04-09 13:00' --no-pager" | grep -iE 'tier|pro|free|grant'
```

#### Q&A Graph Exception

```bash
ssh pi@raspberrypi.local "journalctl -u easyoref --since='2026-04-09 13:00' --no-pager" | grep -iE 'Q&A failed'
```

**Key log message:** `"Q&A failed"` with `error` and `chatId` metadata.

If this appears, the LangGraph pipeline threw an exception. Cross-reference with LangSmith traces using the `langsmith-qa-postmortem` skill.

#### Inline Query Issues

```bash
ssh pi@raspberrypi.local "journalctl -u easyoref --since='2026-04-09 13:00' --no-pager" | grep -iE 'inline|query'
```

Inline queries:

- Empty query → returns current alert status widget
- Text query → runs Q&A graph → returns article
- Cache: 30s (`cache_time: 30`)

#### Group Chat Detection

In groups, the bot responds only when:

1. @mentioned (`@easyorefbot question`)
2. Replied to (reply to bot's message with a question)

If neither detected, the bot ignores the message by design.

### Step 4: Cross-Reference with LangSmith

If `"Q&A failed"` appears in RPi logs:

1. Note the timestamp (IDT)
2. Convert to UTC (subtract 3 hours)
3. Use `langsmith-qa-postmortem` skill with the UTC time range

If NO Q&A-related logs appear at all:

- The question never reached the Q&A handler
- Check tier middleware, rate limiter, or grammY middleware chain

## Tips

- Q&A handler logs are sparse — most debugging requires LangSmith traces
- Rate limiting is silent (no log entry, no user notification)
- Typing indicator runs every 4s — NOT logged. If user sees typing but no answer → LLM hung
- `chatId` in logs maps to: positive = private chat, negative = group chat
- Inline queries are separate from direct messages — different handler, different logs
