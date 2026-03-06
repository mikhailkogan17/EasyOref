# easyoref

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
