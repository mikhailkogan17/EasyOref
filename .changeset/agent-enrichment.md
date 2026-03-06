---
"easyoref": minor
---

feat: LangGraph agent enrichment (GramJS + BullMQ + GPT-5-mini)

- GramJS MTProto monitor for 5 Hebrew news channels
- BullMQ queue/worker with 90s debounce for alert enrichment
- LangGraph 5-tier pipeline: region match → trust scoring → tone calibration → citation formatting
- Redis store for alert-event correlation
- Inline enrichment format with Unicode superscript citations
