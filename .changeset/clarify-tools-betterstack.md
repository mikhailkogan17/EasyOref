---
"easyoref": minor
---

feat: agentic clarification tools — rename, add history/area/logs

- Renamed all LangChain tools (dropped MCP prefix): `read_telegram_sources`, `alert_history`, `resolve_area`
- Added `alert_history` tool — query Pikud HaOref alert history by area and time window
- Added `resolve_area` tool — defense-zone proximity resolver (9 zones, 3-tier matching)
- Added `betterstack_log` tool — query recent pipeline logs from Better Stack via existing Logtail token
- Updated clarify node system prompt for 4 tools
- 80 tests passing
