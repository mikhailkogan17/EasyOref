<p align="center">
  <img src="docs/assets/hero.png" alt="EasyOref" width="100%">
</p>

Smart Home Front Command notifications — for your friends & family

[![CI](https://github.com/mikhailkogan17/EasyOref/actions/workflows/ci.yml/badge.svg)](https://github.com/mikhailkogan17/EasyOref/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![npm](https://img.shields.io/badge/npm-easyoref-CB3837?logo=npm)](https://www.npmjs.com/package/easyoref)

 [עברית](docs/readme_he.md) · [Русский](docs/readme_ru.md)

> [!CAUTION]
> EasyOref **does not replace** official Home Front Command alerts.
> It **supplements** them — keeping your contacts informed.
> Always follow Home Front Command instructions!

## Why

During a rocket attack, your family abroad sees "MISSILES HIT NETANYA" on the news.

They don't know:
- Is it your neighborhood or 200 km away?
- Are you safe?
- Should they worry?

**Nothing solves this today.**
Alert apps with area filtering — for you in Israel.
Cell Broadcast alerts — for you in Israel.

## Features

- **4 languages** — Russian, English, Hebrew, Arabic
- **3 alert types** — early warning, siren, all-clear
- **Custom messages** — your own text and media per alert type

## Install

### 1. Install Node.js

<details>
<summary>Windows</summary>

Download the installer from [nodejs.org](https://nodejs.org/) (LTS, 22+). Run it, click "Next".

</details>

<details>
<summary>macOS</summary>

```bash
brew install node
```

Or download from [nodejs.org](https://nodejs.org/).

</details>

<details>
<summary>Linux / Raspberry Pi</summary>

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

</details>

### 2. Set up Telegram

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the **token**
2. Add the bot to your Telegram chat or channel
3. Forward any message from that chat to [@userinfobot](https://t.me/userinfobot) → copy the **chat ID**

### 3. Find your city ID

Open [cities.json](https://github.com/eladnava/pikud-haoref-api/blob/master/cities.json), find your city, copy the `id` number.

Example: `"id": 722` = Tel Aviv — South & Jaffa.

### 4. Run setup

```bash
npx easyoref init
```

The wizard asks for language, token, chat ID, and city ID. Config is saved to `~/.easyoref/config.yaml`.

### 5. Start the bot

```bash
npx easyoref
```

**Done.** The bot will message your chat whenever the Home Front Command issues an alert for your area.

> The bot needs to run 24/7 — on a Raspberry Pi, server, or always-on computer.
> Guides: [RPi](docs/rpi.md) · [Local](docs/local.md)

## Configuration

Config file: `~/.easyoref/config.yaml`. Created by `npx easyoref init`.

Full reference: [`config.yaml.example`](config.yaml.example).

| Key                      | Default | Description                                                                                         |
| ------------------------ | ------- | --------------------------------------------------------------------------------------------------- |
| `city_ids`               | —       | **required.** [Find city IDs](https://github.com/eladnava/pikud-haoref-api/blob/master/cities.json) |
| `telegram.bot_token`     | —       | **required.** Token from @BotFather                                                                 |
| `telegram.chat_id`       | —       | **required.** Chat ID (negative number)                                                             |
| `language`               | `ru`    | `ru` `en` `he` `ar`                                                                                 |
| `alert_types`            | all     | `early` `siren` `resolved`                                                                          |
| `gif_mode`               | `none`  | `funny_cats` `none`                                                                                 |
| `title_override.*`       | —       | Custom title per alert type                                                                         |
| `description_override.*` | —       | Custom description per alert type                                                                   |

## License

[MIT](LICENSE) — Mikhail Kogan, 2026
