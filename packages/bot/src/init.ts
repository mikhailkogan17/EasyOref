/**
 * `npx easyoref init` — Interactive setup wizard.
 *
 * Asks 4 questions, writes ~/.easyoref/config.yaml.
 */

import { confirm, input, password, select } from "@inquirer/prompts";
import chalk from "chalk";
import { Bot } from "grammy";
import yaml from "js-yaml";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { CONFIG_DIR, HOME_CONFIG_PATH } from "@easyoref/shared";

export async function init(): Promise<void> {
  console.log(chalk.bold("\n🚨 EasyOref Setup\n"));

  // ── Guard: config already exists ─────────────────────
  if (existsSync(HOME_CONFIG_PATH)) {
    const overwrite = await confirm({
      message: `${HOME_CONFIG_PATH} already exists. Overwrite?`,
      default: false,
    });
    if (!overwrite) {
      console.log(chalk.dim("Cancelled."));
      return;
    }
  }

  // ── 1. Language ──────────────────────────────────────
  const language = await select({
    message: "🌍 Language / Язык / שפה:",
    choices: [
      { name: "Русский", value: "ru" },
      { name: "English", value: "en" },
      { name: "עברית", value: "he" },
      { name: "العربية", value: "ar" },
    ],
  });

  const t = STRINGS[language as keyof typeof STRINGS] ?? STRINGS.en;

  // ── 2. Bot Token ─────────────────────────────────────
  const botToken = await password({
    message: t.token,
    validate: (val) => {
      if (!val || val.length < 10) return t.tokenRequired;
      if (!val.includes(":")) return t.tokenFormat;
      return true;
    },
  });

  console.log(chalk.dim(t.validating));
  try {
    const bot = new Bot(botToken);
    const me = await bot.api.getMe();
    console.log(chalk.green(`  ✅ ${t.botOk}: @${me.username}`));
  } catch {
    console.log(chalk.yellow(`  ⚠️  ${t.botFail}`));
  }

  // ── 3. Chat ID ───────────────────────────────────────
  const chatId = await input({
    message: t.chatId,
    validate: (val) => {
      if (!val) return t.chatIdRequired;
      if (!/^-?\d+$/.test(val)) return t.chatIdFormat;
      return true;
    },
  });

  // ── 4. City ID ───────────────────────────────────────
  const cityIdRaw = await input({
    message: t.cityId,
    validate: (val) => {
      if (!val) return t.cityIdRequired;
      if (!/^\d+$/.test(val)) return t.cityIdFormat;
      return true;
    },
  });

  // ── Write config ─────────────────────────────────────
  const cfg = {
    city_ids: [Number(cityIdRaw)],
    language,
    telegram: {
      bot_token: botToken,
      chat_id: chatId,
    },
  };

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(HOME_CONFIG_PATH, yaml.dump(cfg), "utf-8");

  console.log("");
  console.log(chalk.green(`✅ ${t.saved} ${HOME_CONFIG_PATH}`));
  console.log("");
  console.log(t.next);
  console.log(`  ${chalk.cyan("npx easyoref")}`);
  console.log("");
}

// ── i18n strings for the wizard ────────────────────────

const STRINGS = {
  ru: {
    token: "🤖 Токен бота (от @BotFather):",
    tokenRequired: "Токен обязателен",
    tokenFormat: "Формат: 123456:ABC-DEF...",
    validating: "  Проверяем токен...",
    botOk: "Бот найден",
    botFail: "Не удалось проверить (продолжаем)",
    chatId: "💬 Chat ID (отрицательное число для групп):",
    chatIdRequired: "Chat ID обязателен",
    chatIdFormat: "Число (отрицательное для групп)",
    cityId:
      "📍 ID города (найдите на https://github.com/eladnava/pikud-haoref-api/blob/master/cities.json):",
    cityIdRequired: "ID обязателен",
    cityIdFormat: "Только цифры",
    saved: "Конфиг сохранён →",
    next: "Запустите бота:",
  },
  en: {
    token: "🤖 Bot token (from @BotFather):",
    tokenRequired: "Token is required",
    tokenFormat: "Format: 123456:ABC-DEF...",
    validating: "  Validating token...",
    botOk: "Bot found",
    botFail: "Could not verify (continuing anyway)",
    chatId: "💬 Chat ID (negative number for groups):",
    chatIdRequired: "Chat ID is required",
    chatIdFormat: "Must be a number (negative for groups)",
    cityId:
      "📍 City ID (find at https://github.com/eladnava/pikud-haoref-api/blob/master/cities.json):",
    cityIdRequired: "City ID is required",
    cityIdFormat: "Numbers only",
    saved: "Config saved →",
    next: "Start the bot:",
  },
  he: {
    token: "🤖 טוקן בוט (מ-@BotFather):",
    tokenRequired: "טוקן נדרש",
    tokenFormat: "פורמט: 123456:ABC-DEF...",
    validating: "  מאמת טוקן...",
    botOk: "בוט נמצא",
    botFail: "לא ניתן לאמת (ממשיכים)",
    chatId: "💬 Chat ID (מספר שלילי לקבוצות):",
    chatIdRequired: "Chat ID נדרש",
    chatIdFormat: "חייב להיות מספר (שלילי לקבוצות)",
    cityId:
      "📍 ID עיר (מצאו ב-https://github.com/eladnava/pikud-haoref-api/blob/master/cities.json):",
    cityIdRequired: "ID עיר נדרש",
    cityIdFormat: "מספרים בלבד",
    saved: "הגדרות נשמרו →",
    next: "הפעילו את הבוט:",
  },
  ar: {
    token: "🤖 رمز البوت (من @BotFather):",
    tokenRequired: "الرمز مطلوب",
    tokenFormat: "الشكل: 123456:ABC-DEF...",
    validating: "  جارٍ التحقق...",
    botOk: "تم العثور على البوت",
    botFail: "تعذر التحقق (متابعة)",
    chatId: "💬 Chat ID (رقم سالب للمجموعات):",
    chatIdRequired: "Chat ID مطلوب",
    chatIdFormat: "يجب أن يكون رقمًا (سالب للمجموعات)",
    cityId:
      "📍 رقم المدينة (ابحث في https://github.com/eladnava/pikud-haoref-api/blob/master/cities.json):",
    cityIdRequired: "رقم المدينة مطلوب",
    cityIdFormat: "أرقام فقط",
    saved: "تم حفظ الإعدادات →",
    next: "شغّل البوت:",
  },
};
