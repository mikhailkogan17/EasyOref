---
"easyoref": minor
---

Time-aware enrichment pipeline with carry-forward

- Fix Lebanon bug: stale posts from previous attacks no longer contaminate current session
- Phase-specific extraction prompts (early_warning/siren/resolved)
- Time-bounded pre-filter with TIME_WINDOW_MS per phase
- LLM time_relevance scoring, post-filter rejects < 0.5
- Carry-forward enrichment data via Redis across phases
- Inline [[1]](url) citations (no superscripts, no footer)
- Edit dedup via textHash
- Language neutrality: Russian channels scored equally
- Added injuries field to extraction and voting
- 46 new unit tests + 4 integration tests
