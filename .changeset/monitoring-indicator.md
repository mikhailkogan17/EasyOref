---
"easyoref": minor
---

Add monitoring status indicator to active alert messages

- Show "⏳ Мониторинг..." (i18n) below blockquote for early/siren alerts while enrichment agent is active
- Automatically remove indicator when session phase expires, resolved alert arrives, or phase upgrades to new message
- Strip and re-add indicator during enrichment edits to keep it at the bottom
