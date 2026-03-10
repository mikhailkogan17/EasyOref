---
"easyoref": patch
---

Token economy: reduce LLM costs by ~90%

- Switch default model to `gemini-3.1-flash-lite-preview` (2x cheaper per token)
- Increase enrichment intervals: 60s/45s/180s (was 20s/20s/60s) — 3x fewer jobs
- Post-level extraction dedup: cache extraction results in Redis per session,
  only send NEW posts to LLM. Reuse cached results for already-seen posts.
  Saves ~80% of LLM calls per session.
