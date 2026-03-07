---
"easyoref": minor
---

feat: switch agent from OpenAI to Google Gemini, hardcode 14 monitored channels, fix alert window lifecycle

- Replace `@langchain/openai` with `@langchain/google-genai` (Gemini 1.5 Flash — free 15 req/min)
- Config: `openai_api_key` / `openai_model` → `google_api_key` / `google_model`
- Channels hardcoded in `gramjs-monitor.ts` (14 channels), removed from `config.yaml`
- Alert monitoring now stops on `resolved` alert via `clearActiveAlert()`
- 15-min timeout auto-clears active alert if no resolved arrives
