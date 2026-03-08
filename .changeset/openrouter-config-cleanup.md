---
"easyoref": minor
---

fix(ai): migrate to OpenRouter, adaptive cooldown, config cleanup

- **OpenRouter**: replace Google AI Studio direct API with OpenRouter provider
  (same `google/gemini-3-flash-preview` model, no 20 RPD free-tier limit)
- **Adaptive cooldown**: siren cooldown is 3 min if early_warning preceded,
  else 1.5 min (was fixed 90 s)
- **Config rename**: `agent:` → `ai:` YAML section;
  `api_key` → `openrouter_api_key`, `model` → `openrouter_model`
- **Hardcoded base URL**: `https://openrouter.ai/api/v1` no longer configurable
- **Removed**: `google_api_key`, `google_model`, `openrouter_base_url` config fields
- **Auto-join channels**: GramJS now joins all monitored channels at startup
  so `NewMessage` events are received correctly
