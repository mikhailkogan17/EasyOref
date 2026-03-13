<p align="center">
  <img src="assets/hero.png" alt="EasyOref" width="100%">
</p>

Оповещения о ракетных атаках в Израиле — в Telegram вашим близким за границей.

[English](../README.md) · [עברית](readme_he.md)

[![LangGraph](https://img.shields.io/badge/LangGraph-agentic-blue)](https://langchain-ai.github.io/langgraphjs/)
[![LangChain](https://img.shields.io/badge/LangChain-tools-green)](https://js.langchain.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript)](https://www.typescriptlang.org/)

> [!CAUTION]
> EasyOref **не заменяет** официальные каналы оповещений Службы Тыла.
> Бот **дополняет** их — чтобы ваши близкие за границей знали, что вы в порядке.
> Следуйте указаниям Командования Тыла!


## Зачем

Во время ракетной атаки ваши близкие за границей видят в новостях «РАКЕТЫ ПО ТЕЛЬ-АВИВУ».

Они не знают:
- Это ваш район или 200 км от вас?
- Вы в безопасности?
- Нужно ли беспокоиться?

**Готовых решений для них нет.**
Приложения тревоги с фильтром по зоне — для вас в Израиле.
Оповещения через Cell Broadcast — для вас в Израиле.
EasyOref — для ваших близких за границей.

## Возможности

- **4 языка** — русский, английский, иврит, арабский
- **3 типа тревог** — раннее предупреждение, сирена, отбой
- **Кастомные сообщения** — свой текст и медиа для каждого типа тревоги

## Установка

### 1. Установите Node.js

<details>
<summary>Windows</summary>

Скачайте установщик с [nodejs.org](https://nodejs.org/) (LTS, 22+). Запустите, нажимайте «Next».

</details>

<details>
<summary>macOS</summary>

```bash
brew install node
```

Или скачайте с [nodejs.org](https://nodejs.org/).

</details>

<details>
<summary>Linux / Raspberry Pi</summary>

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

</details>

### 2. Подготовьте Telegram

1. Напишите [@BotFather](https://t.me/BotFather) → `/newbot` → скопируйте **токен**
2. Добавьте бота в ваш чат или канал в Telegram
3. Перешлите любое сообщение из чата в [@userinfobot](https://t.me/userinfobot) → скопируйте **chat ID**

### 3. Найдите ID вашего города

Откройте [cities.json](https://github.com/eladnava/pikud-haoref-api/blob/master/cities.json), найдите свой город, скопируйте число из `id`.

Пример: `"id": 722` = Тель-Авив — Юг и Яффо.

### 4. Запустите настройку

```bash
npx easyoref init
```

Мастер установки спросит язык, токен, chat ID и ID города. Конфиг сохранится в `~/.easyoref/config.yaml`.

### 5. Запустите бота

```bash
npx easyoref
```

**Готово.** Бот отправит сообщения в чат при каждой тревоге Службы Тыла в вашем районе.

> Бот должен работать постоянно — на Raspberry Pi, сервере, или компьютере который не выключается.
> Подробнее: [RPi](rpi.md) · [Локально](local.md)

## Как это работает

EasyOref работает в два слоя:

**Основной слой** — всегда активен, задержка <1 сек
- Опрашивает API Pikud HaOref каждые 2 секунды
- Фильтрует по ID города (с учётом зон кипат барзель)
- Доставляет в Telegram мгновенно

**Агентный слой обогащения** — LangGraph пайплайн на каждую тревогу

```
collectAndFilter → extract → vote → [clarify → revote] → editMessage
```

1. **collectAndFilter** — сбор постов из каналов, детерминированный фильтр шума, трекинг каналов
2. **extract** — двухэтапный LLM: дешёвый пре-фильтр релевантности → дорогой структурированный экстракт (количество ракет, перехваты, зона поражения, страна запуска)
3. **vote** — консенсус по нескольким экстракциям, оценка уверенности
4. **clarify** *(условно)* — запускается при низкой уверенности или подозрительных данных из одного источника; LLM вызывает инструменты:
   - `read_telegram_sources` — живая выборка из каналов IDF/новостей через MTProto
   - `alert_history` — проверка утверждений по истории API Pikud HaOref
   - `resolve_area` — проверка близости по зоне кипат барзель
   - `betterstack_log` — запрос логов пайплайна обогащения
5. **revote** — повторный консенсус с уточнёнными данными
6. **editMessage** — редактирование сообщения Telegram in-place с источниками

LangGraph `MemorySaver` сохраняет состояние по `alertId`. Graceful degradation: `ai.enabled: false` → только основной слой, без зависимости от LLM.

## Конфигурация

Конфиг: `~/.easyoref/config.yaml`. Создаётся командой `npx easyoref init`.

Полный список опций — в [`config.yaml.example`](../config.yaml.example).

| Ключ                     | По умолчанию | Описание                                                                                                 |
| ------------------------ | ------------ | -------------------------------------------------------------------------------------------------------- |
| `city_ids`               | —            | **обязательно.** [Найти ID города](https://github.com/eladnava/pikud-haoref-api/blob/master/cities.json) |
| `telegram.bot_token`     | —            | **обязательно.** Токен от @BotFather                                                                     |
| `telegram.chat_id`       | —            | **обязательно.** ID чата (отрицательное число)                                                           |
| `language`               | `ru`         | `ru` `en` `he` `ar`                                                                                      |
| `alert_types`            | все          | `early` `siren` `resolved`                                                                               |
| `gif_mode`               | `none`       | `funny_cats` `none`                                                                                      |
| `title_override.*`       | —            | Свой заголовок по типу тревоги                                                                           |
| `description_override.*` | —            | Своё описание по типу тревоги                                                                            |

## Лицензия

[MIT](../LICENSE) — Михаил Коган, 2026
