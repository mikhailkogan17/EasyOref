# EasyOref

Оповещения о ракетных атаках в Израиле — в вашем чате в Telegram.

[English](../README.md) · [עברית](readme_he.md)

> [!CAUTION]
> EasyOref **не заменяет** официальные каналы оповещений Службы Тыла.
> Бот **дополняет** их для ваших близких вне Израиля.
> Следуйте указаниям Командования Тыла!

## Зачем

Во время ракетной атаки ваши близкие видят в новостях «РАКЕТЫ ПО НЕТАНИИ».

Они не знают:
- Это ваш район или 200 км от вас?
- Вы в безопасности?
- Нужно ли беспокоиться?

**Готовых решений нет.**
Приложения тревоги с фильтром по зоне — для вас в Израиле.
Оповещения через Cell Broadcast — для вас в Израиле.

## Возможности

- **4 языка** — русский, английский, иврит, арабский
- **3 типа тревог** — раннее предупреждение, сирена, отбой
- **Кастомные сообщения** — свои описания и медиа для каждого типа тревоги

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
2. Добавьте бота в семейный чат
3. Перешлите любое сообщение из чата в [@userinfobot](https://t.me/userinfobot) → скопируйте **chat ID**

### 3. Найдите ID вашего города

Откройте [cities.json](https://github.com/eladnava/pikud-haoref-api/blob/master/cities.json), найдите свой город, скопируйте число из `id`.

Пример: `"id": 722` = Тель-Авив — Юг и Яффо.

### 4. Запустите визард

```bash
npx easyoref init
```

Визард спросит язык, токен, chat ID и ID города. Конфиг сохранится в `~/.easyoref/config.yaml`.

### 5. Запустите бота

```bash
npx easyoref
```

**Готово.** Бот отправит сообщения в чат при получении оповещений от Службы Тыла.

> Бот должен работать постоянно — на RPi, сервере, или компьютере который не выключается.
> Подробнее: [RPi](rpi.md) · [Локально](local.md)

## Конфигурация

Конфиг: `~/.easyoref/config.yaml`. Создаётся командой `npx easyoref init`.

Полный список опций — в [`config.yaml.example`](../config.yaml.example).

| Ключ                     | По умолчанию | Описание                                                                                                 |
| ------------------------ | ------------ | -------------------------------------------------------------------------------------------------------- |
| `city_ids`               | —            | **обязательно.** [Найти ID города](https://github.com/eladnava/pikud-haoref-api/blob/master/cities.json) |
| `telegram.bot_token`     | —            | **обязательно.** Токен от @BotFather                                                                     |
| `telegram.chat_id`       | —            | **обязательно.** ID чата (отрицательное число)                                                           |
| `language`               | `ru`         | `ru` `en` `he` `ar`                                                                                      |
| `alert_types`            | все          | `early` `siren` `incident_over`                                                                          |
| `gif_mode`               | `none`       | `funny_cats` `assertive` `pikud_haoref` `none`                                                           |
| `title_override.*`       | —            | Свой заголовок по типу тревоги                                                                           |
| `description_override.*` | —            | Своё описание по типу тревоги                                                                            |

## Лицензия

[MIT](../LICENSE) — Михаил Коган, 2026
