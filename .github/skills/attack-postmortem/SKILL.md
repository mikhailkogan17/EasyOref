---
name: attack-postmortem
description: "Investigate EasyOref enrichment pipeline failures using LangSmith traces. Use when: attack happened, enrichment failed, no metadata sent, wrong ETA, duplicate alerts, empty synthesis, model errors, postmortem analysis. Requires LangSmith MCP tools."
argument-hint: "Describe the attack time, date, or symptom (e.g., 'April 9 attack, no enrichment metadata')"
---

# Attack Postmortem — LangSmith Investigation

Investigate EasyOref enrichment pipeline failures by analyzing LangSmith traces from real attacks.

## When to Use

- After a Red Alert attack where enrichment metadata was missing, wrong, or delayed
- When a user reports "no metadata", "wrong ETA", "duplicate alerts", or "empty synthesis"
- For postmortem analysis of pipeline behavior during an incident
- To diagnose model failures, GraphRecursionErrors, or carry-forward data loss

## Prerequisites

- LangSmith MCP tools available (`mcp_langsmith_fetch_runs`, `mcp_langsmith_list_projects`)
- LangSmith project name: `easyoref`

## Procedure

### Step 1: Find the Attack Traces

Fetch recent root traces to identify the attack timeline. Root traces = one per enrichment run.

```
mcp_langsmith_fetch_runs(
  project_name="easyoref",
  limit=20,
  is_root="true",
  order_by="-start_time",
  preview_chars=80,
  max_chars_per_page=15000
)
```

**Key fields in each root trace:**

- `inputs.alertType`: `early_warning` → `red_alert` → `resolved` (attack lifecycle)
- `inputs.alertTs`: Unix ms timestamp of the alert
- `inputs.sessionStartTs`: When the session began (first early_warning)
- `inputs.previousInsights`: Carry-forward data from prior phases
- `inputs.alertAreas`: Hebrew area names
- `status`: `success` / `error` / `pending`
- `total_tokens`: Token usage (high = model looping)

**If traces are too large**, reduce `preview_chars` to `30` or use time-based FQL filter:

```
filter='gt(start_time, "2026-04-09T00:00:00Z")'
```

**Group traces by attack:** Same `sessionStartTs` = same attack session. Different `alertType` values show phase progression.

### Step 2: Map the Attack Timeline

Build a timeline table from root traces:

| Time (UTC) | alertType     | status  | tokens | previousInsights  | trace_id |
| ---------- | ------------- | ------- | ------ | ----------------- | -------- |
| 22:14:28   | early_warning | success | 45K    | []                | abc-123  |
| 22:16:02   | red_alert     | success | 89K    | [country_origins] | def-456  |
| 22:24:30   | resolved      | pending | 120K   | [country_origins] | ghi-789  |

**Red flags:**

- `previousInsights: []` on red_alert/resolved = carry-forward broken
- `status: error` = pipeline crashed
- `status: pending` after >10 min = pipeline hung
- High `total_tokens` (>500K) = model looping / GraphRecursionError
- Missing `early_warning` trace = enrichment never started

### Step 3: Drill Into a Failing Trace

Fetch all child runs for a specific trace:

```
mcp_langsmith_fetch_runs(
  project_name="easyoref",
  trace_id="<trace_id_from_step_2>",
  limit=50,
  order_by="start_time",
  preview_chars=100,
  max_chars_per_page=20000
)
```

**Expected node sequence (5-node pipeline):**

1. `__start__` → initialization
2. `pre-filter` → noise filtering + tracking
3. `extract-channel` ×N → one per channel with posts (parallel)
4. `post-filter` → relevance validation
5. `synthesize` → voting + LLM synthesis
6. `edit` → Telegram message editing

**Also look for:**

- `ChatOpenRouter` (run_type=`llm`) → actual LLM calls
- `model_request` (run_type=`chain`) → agent framework wrapper

### Step 4: Diagnose Common Failures

#### No metadata sent to users

Check `edit` node output. Look for:

- `sendMetaReply` guard: does it check `hasRocket || hasEta || hasOrigin`?
- `editTelegramMessage` guard: is `alertType !== "early_warning"` blocking?
- Empty `synthesizedKeys: []` → synthesis returned nothing

#### Empty synthesis despite consensus

Check `synthesize` node:

- `consensusKinds` vs `synthesizedKeys` mismatch = LLM returned `{fields: []}`
- Check if fallback retry triggered (should retry when primary returns empty)

#### Model errors / GraphRecursionError

Check `ChatOpenRouter` runs with `error` field:

- "Insufficient credits" → OpenRouter billing issue
- "GraphRecursionError" → model entering tool-call loop, check `recursionLimit`
- Long latency (>30s) on LLM run → timeout should trigger fallback

#### Watermark data loss

Check `pre-filter` node output:

- `channelsWithUpdates: []` but `previousInsights` exists = all posts watermarked
- Channels with only `previous` posts should be re-surfaced (v1.27.6 fix)

#### Duplicate alerts

Not visible in LangSmith — check RPi logs via SSH:

```bash
ssh pi@raspberrypi.local "journalctl -u easyoref -n 100 --since='2026-04-09 22:00'"
```

### Step 5: Check LLM Call Details

For specific LLM failures, fetch errored runs:

```
mcp_langsmith_fetch_runs(
  project_name="easyoref",
  trace_id="<trace_id>",
  run_type="llm",
  error="true",
  limit=20,
  preview_chars=200
)
```

**Check in outputs:**

- `response_metadata.model` → which model actually served the request
- `response_metadata.usage` → token counts per call
- `tool_calls` → was structured output (tool use) attempted?

### Step 6: Write Postmortem

After investigation, update `AGENTS.md` with:

1. **Context**: Attack time, areas, bot version
2. **Root Causes**: Each bug numbered with evidence from LangSmith
3. **Evidence**: Trace IDs, node outputs, timestamps
4. **Files Modified**: Table of changes
5. **Tests**: Updated test count

Reference format: see existing postmortems in [AGENTS.md](../../AGENTS.md) (search "Postmortem").

## Known Bug Patterns (from prior postmortems)

| Pattern                    | Symptom                                         | Root Cause                                    | Fix Version            |
| -------------------------- | ----------------------------------------------- | --------------------------------------------- | ---------------------- |
| sendMetaReply origin guard | No metadata despite origin extracted            | Guard only checked `hasRocket \|\| hasEta`    | v2.0.3                 |
| GraphRecursionError        | High tokens, all extract-channel fail           | `recursionLimit` too high (25→10)             | v2.0.5                 |
| Watermark data loss        | `channelsWithUpdates: []` on retry runs         | `buildTracking()` excluded old-only channels  | v1.27.6                |
| Empty synthesis            | `consensusKinds > 0, synthesizedKeys = 0`       | Primary LLM returned empty, no fallback retry | v2.0.5                 |
| ETA neuroslop              | Wrong ETA time (e.g., ~09:17 instead of ~09:12) | LLM computed from wrong base time             | v2.0.6 (pass-through)  |
| Cooldown lost on restart   | Duplicate alerts after deploy                   | `lastSent` was in-memory only                 | v2.0.6 (Redis persist) |
| Edited messages missed     | Channel data not captured                       | Only `NewMessage` handler, no `EditedMessage` | v2.0.6                 |

## Tips

- **preview_chars**: Use `30-50` for timeline overview, `200+` for detailed output inspection
- **Pagination**: LangSmith paginates by character budget. Check `total_pages` and iterate with `page_number`
- **FQL filter examples**:
  - Errored runs: `'neq(error, null)'`
  - Slow runs: `'gt(latency, "30s")'`
  - By name: `'eq(name, "synthesize-node")'`
- **Time conversion**: LangSmith uses UTC. Israel = UTC+3 (IDT) or UTC+2 (IST)
- **Token sanity check**: Normal enrichment run ≈ 50-150K tokens. >500K = model looping
