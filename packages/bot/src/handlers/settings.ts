import {
  getBotStrings,
  getUser,
  isValidLanguage,
  saveUser,
  translateAreas,
  type Language,
} from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import { InlineKeyboard, Keyboard, type Bot } from "grammy";
import { mainMenuKeyboard, setAwaitingLocation } from "./start.js";

const settingsKeyboard = (lang: Language) => {
  const s = getBotStrings(lang);
  return new InlineKeyboard()
    .text(s.settingsLanguage, "settings:lang")
    .text(s.settingsLocation, "settings:location")
    .row()
    .text(s.settingsInfo, "settings:info");
};

const langKeyboard = new InlineKeyboard()
  .text("🇷🇺 Русский", "setlang:ru")
  .text("🇬🇧 English", "setlang:en")
  .row()
  .text("🇮🇱 עברית", "setlang:he")
  .text("🇸🇦 العربية", "setlang:ar");

export function registerSettingsHandler(bot: Bot): void {
  // ── /settings command ───────────────────────────────
  bot.command("settings", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const user = await getUser(chatId);
    if (!user) {
      await ctx.reply(getBotStrings("ru").qaNotRegistered);
      return;
    }
    const lang = user.language as Language;
    const s = getBotStrings(lang);
    await ctx.reply(s.settingsTitle, { reply_markup: settingsKeyboard(lang) });
  });

  // ── Settings button from reply keyboard ─────────────
  bot.hears(
    [
      getBotStrings("ru").btnSettings,
      getBotStrings("en").btnSettings,
      getBotStrings("he").btnSettings,
      getBotStrings("ar").btnSettings,
    ],
    async (ctx) => {
      const chatId = String(ctx.chat.id);
      const user = await getUser(chatId);
      if (!user) return;
      const lang = user.language as Language;
      const s = getBotStrings(lang);
      await ctx.reply(s.settingsTitle, {
        reply_markup: settingsKeyboard(lang),
      });
    },
  );

  // ── Language sub-flow ───────────────────────────────
  bot.callbackQuery("settings:lang", async (ctx) => {
    await ctx.answerCallbackQuery();
    const chatId = String(ctx.from.id);
    const user = await getUser(chatId);
    const lang = (user?.language ?? "ru") as Language;
    const s = getBotStrings(lang);
    await ctx.editMessageText(s.askLanguage, { reply_markup: langKeyboard });
  });

  bot.callbackQuery(/^setlang:/, async (ctx) => {
    const lang = ctx.callbackQuery.data.slice(8) as Language;
    if (!isValidLanguage(lang)) {
      await ctx.answerCallbackQuery("Invalid language");
      return;
    }
    await ctx.answerCallbackQuery();

    const chatId = String(ctx.from.id);
    const user = await getUser(chatId);
    if (!user) return;

    await saveUser({ ...user, language: lang, lastActiveAt: Date.now() });
    const s = getBotStrings(lang);

    await ctx
      .editMessageReplyMarkup({ reply_markup: undefined })
      .catch(() => {});
    await ctx.reply(s.languageSaved, {
      reply_markup: mainMenuKeyboard(lang),
    });
    logger.info("Language changed via settings", { chatId, lang });
  });

  // ── Location sub-flow ──────────────────────────────
  bot.callbackQuery("settings:location", async (ctx) => {
    await ctx.answerCallbackQuery();
    const chatId = String(ctx.from.id);
    const user = await getUser(chatId);
    const lang = (user?.language ?? "ru") as Language;
    const s = getBotStrings(lang);

    const locationKb = new Keyboard()
      .requestLocation(s.shareLocationBtn)
      .resized()
      .oneTime();

    await ctx
      .editMessageReplyMarkup({ reply_markup: undefined })
      .catch(() => {});
    setAwaitingLocation(chatId);
    await ctx.reply(s.askLocation, { reply_markup: locationKb });
  });

  // ── Info sub-flow ──────────────────────────────────
  bot.callbackQuery("settings:info", async (ctx) => {
    await ctx.answerCallbackQuery();
    const chatId = String(ctx.from.id);
    const user = await getUser(chatId);
    if (!user) return;

    const lang = user.language as Language;
    const s = getBotStrings(lang);
    const translatedAreas = translateAreas(user.areas.join(", "), lang);

    const text = s.infoDisplay
      .replace("{chatId}", user.chatId)
      .replace("{lang}", lang)
      .replace("{tier}", user.tier)
      .replace("{areas}", translatedAreas);

    await ctx.editMessageText(text, { parse_mode: "HTML" });
  });
}
