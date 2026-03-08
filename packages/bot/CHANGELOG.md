# easyoref

## 1.11.1

### Patch Changes

- fix: upgrade all langchain packages to v1.x

  - @langchain/core: 0.3.80 → 1.1.31
  - @langchain/openai: 1.2.12 (was incompatible with core@0.3, now matched)
  - @langchain/langgraph: 0.2.x → 1.2.1

  Fixes ERR_PACKAGE_PATH_NOT_EXPORTED crash on startup.

## 1.11.0

### Minor Changes

- [#37](https://github.com/mikhailkogan17/easyoref/pull/37) [`25a3d01`](https://github.com/mikhailkogan17/easyoref/commit/25a3d018f2d8c4d053dc6d48c7b2c43239625d7e) Thanks [@mikhailkogan17](https://github.com/mikhailkogan17)! - fix(ai): migrate to OpenRouter, adaptive cooldown, config cleanup

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

## 1.10.1

### Patch Changes

- [#35](https://github.com/mikhailkogan17/easyoref/pull/35) [`7e3fb18`](https://github.com/mikhailkogan17/easyoref/commit/7e3fb184fe4de6e072a4d4a5fa9966b0bc137453) Thanks [@mikhailkogan17](https://github.com/mikhailkogan17)! - fix: upgrade to gemini-3-flash-preview (1.5-flash deprecated), remove "Данные уточняются..." pending text

## 1.10.0

### Minor Changes

- [#31](https://github.com/mikhailkogan17/easyoref/pull/31) [`439f579`](https://github.com/mikhailkogan17/easyoref/commit/439f5792b7acfbf039c4a7d992dac9d61bdbfa76) Thanks [@mikhailkogan17](https://github.com/mikhailkogan17)! - feat: qualitative breakdown descriptors ("все перехвачены", ">5 упали в море", etc.) when channels report without exact numbers; confidence-gated ("нет" only at >95%); no inference from absence

## 1.9.0

### Minor Changes

- [#29](https://github.com/mikhailkogan17/easyoref/pull/29) [`e331a21`](https://github.com/mikhailkogan17/easyoref/commit/e331a210dec06a012aaa38347e47c906f2db47fc) Thanks [@mikhailkogan17](https://github.com/mikhailkogan17)! - Repeat Gemini enrichment every 20s while alert is active (was one-shot at 90s)

- [#29](https://github.com/mikhailkogan17/easyoref/pull/29) [`e331a21`](https://github.com/mikhailkogan17/easyoref/commit/e331a210dec06a012aaa38347e47c906f2db47fc) Thanks [@mikhailkogan17](https://github.com/mikhailkogan17)! - New rocket format with breakdown, uncertainty markers, hits line

### Patch Changes

- [#29](https://github.com/mikhailkogan17/easyoref/pull/29) [`e331a21`](https://github.com/mikhailkogan17/easyoref/commit/e331a210dec06a012aaa38347e47c906f2db47fc) Thanks [@mikhailkogan17](https://github.com/mikhailkogan17)! - Auto-join monitored channels on GramJS startup to receive NewMessage events

## 1.8.0

### Minor Changes

- [#27](https://github.com/mikhailkogan17/easyoref/pull/27) [`76ae41f`](https://github.com/mikhailkogan17/easyoref/commit/76ae41f4f9128d1127fd515d897f9c3e1a20a2dc) Thanks [@mikhailkogan17](https://github.com/mikhailkogan17)! - Repeat Gemini enrichment every 20s while alert is active (was one-shot at 90s)

### Patch Changes

- [#27](https://github.com/mikhailkogan17/easyoref/pull/27) [`76ae41f`](https://github.com/mikhailkogan17/easyoref/commit/76ae41f4f9128d1127fd515d897f9c3e1a20a2dc) Thanks [@mikhailkogan17](https://github.com/mikhailkogan17)! - Auto-join monitored channels on GramJS startup to receive NewMessage events

## 1.7.1

### Patch Changes

- [#25](https://github.com/mikhailkogan17/easyoref/pull/25) [`2244259`](https://github.com/mikhailkogan17/easyoref/commit/2244259561d15c44e0fe21ad6588ba6cf9232578) Thanks [@mikhailkogan17](https://github.com/mikhailkogan17)! - Auto-join monitored channels on GramJS startup to receive NewMessage events

## 1.7.0

### Minor Changes

- [#22](https://github.com/mikhailkogan17/easyoref/pull/22) [`5f34bfc`](https://github.com/mikhailkogan17/easyoref/commit/5f34bfc66f929977dfbeba4d3c1fc6ed8306169c) Thanks [@mikhailkogan17](https://github.com/mikhailkogan17)! - feat: switch agent from OpenAI to Google Gemini, hardcode 14 monitored channels, fix alert window lifecycle

  - Replace `@langchain/openai` with `@langchain/google-genai` (Gemini 1.5 Flash — free 15 req/min)
  - Config: `openai_api_key` / `openai_model` → `google_api_key` / `google_model`
  - Channels hardcoded in `gramjs-monitor.ts` (14 channels), removed from `config.yaml`
  - Alert monitoring now stops on `resolved` alert via `clearActiveAlert()`
  - 15-min timeout auto-clears active alert if no resolved arrives

## 1.6.0

### Minor Changes

- [#20](https://github.com/mikhailkogan17/easyoref/pull/20) [`479cc30`](https://github.com/mikhailkogan17/easyoref/commit/479cc3006d3f09eb845b5dca6e8b302b5e6a4a2f) Thanks [@mikhailkogan17](https://github.com/mikhailkogan17)! - feat: LangGraph agent enrichment (GramJS + BullMQ + GPT-5-mini)

  - GramJS MTProto monitor for 5 Hebrew news channels
  - BullMQ queue/worker with 90s debounce for alert enrichment
  - LangGraph 5-tier pipeline: region match → trust scoring → tone calibration → citation formatting
  - Redis store for alert-event correlation
  - Inline enrichment format with Unicode superscript citations

## 1.1.0

### Minor Changes

- [#4](https://github.com/mikhailkogan17/EasyOref/pull/4) [`34932a0`](https://github.com/mikhailkogan17/EasyOref/commit/34932a0945af49d59e37bdf29a7e19e90eca30a4) Thanks [@mikhailkogan17](https://github.com/mikhailkogan17)! - ### Added

  - Interactive setup wizard (`npx easyoref init`) — generates `~/.easyoref/config.yaml`
  - `emoji_override` config field — override emoji independently from title
  - Gitleaks secret detection (CI + pre-commit + Danger)
  - Arabic language support (ru/en/he/ar)
  - GIF modes: `funny_cats`, `assertive`, `pikud_haoref`, `none`
  - Persistent GIF rotation across container restarts
  - Alert type filtering (`early`, `siren`, `resolved`)
  - City ID resolution via `cities.json` at startup
  - Per-alert title/description overrides in YAML config

  ### Changed

  - Refactored i18n: function templates → structured `LanguagePack`
  - Default early emoji: 🚀 → ⚠️ (all languages)
  - Default siren title (ru): Сирена → Цева Адом
  - Default siren description (ru): empty (was "Войдите в помещение")
  - `formatMessage` uses per-field overrides (emoji/title/description independently)
  - Replaced `.env` config with `config.yaml` (env vars still work as fallback)
  - Rewritten docs (architecture, local, rpi)

  ### Fixed

  - Logger now reads `logtailToken` from config (was broken `process.env` direct read)
  - Upstream translation fix for "Тель-Авив — Южный район и Яффо"
