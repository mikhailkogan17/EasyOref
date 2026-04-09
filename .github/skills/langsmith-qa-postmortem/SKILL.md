---
name: langsmith-qa-postmortem
description: "Investigate EasyOref Q&A pipeline failures using LangSmith traces. Use when: Q&A answer wrong, Q&A timeout, bot didn't reply, intent misclassified, context empty, answer hallucinated, off_topic false positive. Requires LangSmith MCP tools."
argument-hint: "Describe the Q&A failure (e.g., 'user asked about last attack, got no answer')"
---

# Q&A Postmortem — LangSmith Investigation

Investigate EasyOref Q&A graph failures by analyzing LangSmith traces.

## When to Use

- User asked the bot a question and got no answer, wrong answer, or timed out
- Intent was misclassified (e.g., security question classified as `off_topic`)
- Context was empty despite active session / recent attacks
- Answer was hallucinated or in wrong language

## Prerequisites

- LangSmith MCP tools (`mcp_langsmith_fetch_runs`)
- LangSmith project name: `easyoref`

## Procedure

### Step 1: Find the Q&A Traces

Q&A traces are also in the `easyoref` project but have different input shape. Filter by name or search for `userMessage`:

```
mcp_langsmith_fetch_runs(
  project_name="easyoref",
  limit=20,
  is_root="true",
  order_by="-start_time",
  preview_chars=100,
  max_chars_per_page=15000,
  filter='search("userMessage")'
)
```

**Alternatively**, if you know the approximate time:

```
filter='and(gt(start_time, "2026-04-09T13:00:00Z"), lt(start_time, "2026-04-09T14:00:00Z"))'
```

**Key input fields for Q&A traces:**

- `inputs.userMessage`: The user's question text
- `inputs.chatId`: Telegram chat ID
- `inputs.language`: `ru` / `en` / `he`
- `inputs.intent`: Classified intent (may be in outputs)

### Step 2: Map the Q&A Flow

The Q&A graph has 3 nodes:

| Node | Name in LangSmith | Purpose                          | Tokens     |
| ---- | ----------------- | -------------------------------- | ---------- |
| 1    | `intent-classify` | Deterministic regex classifier   | 0 (no LLM) |
| 2    | `context-gather`  | Redis + Oref API + channel posts | 0 (no LLM) |
| 3    | `answer-generate` | LLM structured answer generation | Variable   |

Fetch child runs for the trace:

```
mcp_langsmith_fetch_runs(
  project_name="easyoref",
  trace_id="<trace_id>",
  limit=20,
  order_by="start_time",
  preview_chars=200,
  max_chars_per_page=20000
)
```

Build a timing table:

| Node              | Start    | End      | Duration | Status  | Notes                      |
| ----------------- | -------- | -------- | -------- | ------- | -------------------------- |
| `intent-classify` | 13:33:48 | 13:33:48 | 11ms     | success | classified `current_alert` |
| `context-gather`  | 13:33:48 | 13:33:48 | 11ms     | success | returned "No active alert" |
| `answer-generate` | 13:33:48 | 13:42:43 | 8m55s    | error   | timeout                    |

### Step 3: Diagnose Intent Classification

Check `intent-classify` output for the `intent` field.

**Valid intents:**

- `current_alert` — questions about active/recent alerts
- `recent_history` — questions about past alerts (yesterday, last week)
- `general_security` — general security situation questions
- `bot_help` — questions about the bot itself
- `off_topic` — non-security questions (short-circuited, no LLM call)

**Common misclassifications:**

- Security question classified as `off_topic` → check intent.ts regex patterns
- History question classified as `current_alert` → may get empty context if no active session

### Step 4: Diagnose Context Gathering

Check `context-gather` output for the `context` field.

**5 data sources checked (in order):**

1. Active Redis session (`getActiveSession()`)
2. Enrichment cache (`getSynthesizedInsights()`)
3. Current Oref API (`fetchTzevaAdom()`)
4. Oref history API (`fetchTzevaAdomHistory()`)
5. Channel posts from Redis (GramJS stored posts)

**Failure patterns:**

- `"No active alert at the moment."` only → sources 2-5 not queried (old bug, fixed v2.0.4)
- Empty context despite recent attack → Redis session expired (TTL), check `phaseTimeoutMs`
- Oref API timeout → `fetchTzevaAdomHistory failed` logged, context degraded

### Step 5: Diagnose Answer Generation

Check `answer-generate` node and its child `ChatOpenRouter` LLM calls.

**Failure patterns:**

- **Timeout (>30s)**: `AbortSignal.timeout(30_000)` should trigger. If not present → missing timeout fix
- **Structured output hung**: `withStructuredOutput()` on some models hangs indefinitely → check if fallback triggered
- **Wrong language**: Check `language` in state vs answer text
- **No citations**: System prompt should instruct `[[channel_name]](url)` format

**LLM call details:**

```
mcp_langsmith_fetch_runs(
  project_name="easyoref",
  trace_id="<trace_id>",
  run_type="llm",
  limit=10,
  preview_chars=300
)
```

### Step 6: Check Rate Limiting

If user reports "no response at all", rate limiter may have blocked (5 questions/min per chatId).
This is NOT visible in LangSmith — check RPi logs with the `rpi-qa-logs` skill.

## Known Q&A Bug Patterns

| Pattern                  | Symptom                                | Root Cause                                       | Fix Version |
| ------------------------ | -------------------------------------- | ------------------------------------------------ | ----------- |
| Context too shallow      | "No data" answer despite recent attack | Only checked `getActiveSession()`, not 5 sources | v2.0.4      |
| LLM timeout              | 8+ minute wait, then generic fallback  | No `AbortSignal.timeout()` on LLM calls          | v2.0.4      |
| Off-topic false positive | Security question rejected             | Regex patterns too narrow in `intent.ts`         | v2.0.4      |
| Wrong language answer    | Russian question, English answer       | `language` not propagated to answer node         | v2.0.2      |

## Tips

- Q&A traces are smaller than enrichment traces (usually 3-5 runs total)
- `intent-classify` and `context-gather` use zero tokens — if problems are there, it's logic bugs not LLM
- `answer-generate` is the only LLM node — check for model, latency, structured output issues
- Status callbacks (`"🔎 Checking alerts..."`) are NOT logged to LangSmith — check RPi logs
