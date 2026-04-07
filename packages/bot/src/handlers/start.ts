import {
  config,
  findAreaByLocation,
  getBotStrings,
  getUser,
  isValidLanguage,
  resolveCityIds,
  saveUser,
  translateAreas,
  type Language,
  type UserConfigType as UserConfig,
} from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import { InlineKeyboard, Keyboard, type Bot } from "grammy";

/** Default areas from config city_ids (resolved at startup via initTranslations) */
let defaultAreas: string[] = [];

export function initDefaultAreas(): void {
  if (config.cityIds.length > 0) {
    defaultAreas = resolveCityIds(config.cityIds);
  }
}

function getDefaultAreas(): string[] {
  return defaultAreas.length > 0 ? defaultAreas : ["תל אביב - דרום העיר ויפו"];
}

/** Persistent reply keyboard shown after registration */
export function mainMenuKeyboard(lang: Language): Keyboard {
  const s = getBotStrings(lang);
  return new Keyboard()
    .text(s.btnShelter)
    .text(s.btnSettings)
    .resized()
    .persistent();
}

/** Track users who are currently in the "send location for area" flow */
const awaitingLocation = new Set<string>();

/** Mark a chatId as awaiting location (used by settings handler too) */
export function setAwaitingLocation(chatId: string): void {
  awaitingLocation.add(chatId);
}

const langKeyboard = new InlineKeyboard()
  .text("🇷🇺 Русский", "lang:ru")
  .text("🇬🇧 English", "lang:en")
  .row()
  .text("🇮🇱 עברית", "lang:he")
  .text("🇸🇦 العربية", "lang:ar");

/**
 * Interactive /start onboarding:
 *   1. Show welcome + language inline keyboard
 *   2. User picks language → ask for location (reply keyboard with 📍)
 *   3. User sends location → detect area via polygon → save → confirm
 *   4. Or user skips → use default area → save → confirm
 *
 * In groups: /start [lang] — simple registration (no interactive flow).
 */
export function registerStartHandler(bot: Bot): void {
  // ── /start command ──────────────────────────────────
  bot.command("start", async (ctx) => {
    const chatId = String(ctx.chat.id);

    // Groups: simple registration with optional lang arg
    if (ctx.chat.type !== "private") {
      const args = ctx.match?.trim();
      let lang: Language = "ru";
      if (args && isValidLanguage(args)) lang = args;
      const areas = getDefaultAreas();
      const existing = await getUser(chatId);
      const user: UserConfig = {
        chatId,
        language: lang,
        areas,
        tier: existing?.tier ?? "free",
        registeredAt: existing?.registeredAt ?? Date.now(),
        lastActiveAt: Date.now(),
      };
      await saveUser(user);
      const s = getBotStrings(lang);
      const translatedAreas = translateAreas(areas.join(", "), lang);
      await ctx.reply(
        s.registered
          .replace("{lang}", lang)
          .replace("{areas}", translatedAreas),
        { parse_mode: "HTML" },
      );
      logger.info("Group registered via /start", { chatId, lang });
      return;
    }

    // Private: interactive flow — show language picker
    await ctx.reply(getBotStrings("ru").welcome, {
      reply_markup: langKeyboard,
    });
  });

  // ── Language selection callback ─────────────────────
  bot.callbackQuery(/^lang:/, async (ctx) => {
    const lang = ctx.callbackQuery.data.slice(5) as Language;
    if (!isValidLanguage(lang)) {
      await ctx.answerCallbackQuery("Invalid language");
      return;
    }

    const chatId = String(ctx.from.id);
    await ctx.answerCallbackQuery();

    // Save language choice temporarily — full save after location
    const existing = await getUser(chatId);
    const s = getBotStrings(lang);

    if (existing) {
      // Returning user changing language via /start
      await saveUser({ ...existing, language: lang, lastActiveAt: Date.now() });
    }

    // Remove inline keyboard from welcome message
    await ctx
      .editMessageReplyMarkup({ reply_markup: undefined })
      .catch(() => {});

    // Ask for location
    const locationKb = new Keyboard()
      .requestLocation(s.shareLocationBtn)
      .row()
      .text(s.skipLocationBtn)
      .resized()
      .oneTime();

    await ctx.reply(s.askLocation, { reply_markup: locationKb });

    // Mark user as awaiting location for area detection
    awaitingLocation.add(chatId);

    // Store pending language in a lightweight way (callback data prefix)
    // We'll read it back from the user record or fallback to what we just set
    if (!existing) {
      // Pre-create user with default areas, will update on location
      const user: UserConfig = {
        chatId,
        language: lang,
        areas: getDefaultAreas(),
        tier: "free",
        registeredAt: Date.now(),
        lastActiveAt: Date.now(),
      };
      await saveUser(user);
    }
  });

  // ── Location received (onboarding or settings) ─────
  bot.on("message:location", async (ctx, next) => {
    const chatId = String(ctx.chat.id);

    // Only handle if user is in "awaiting location for area" flow
    if (!awaitingLocation.has(chatId)) {
      await next();
      return;
    }
    awaitingLocation.delete(chatId);

    const user = await getUser(chatId);
    if (!user) {
      await next();
      return;
    }

    const { latitude, longitude } = ctx.message.location;
    const detectedArea = findAreaByLocation(latitude, longitude);
    const lang = user.language as Language;
    const s = getBotStrings(lang);

    let areas: string[];
    if (detectedArea) {
      areas = [detectedArea];
      const translatedArea = translateAreas(detectedArea, lang);
      await ctx.reply(s.areaDetected.replace("{area}", translatedArea));
    } else {
      areas = getDefaultAreas();
      await ctx.reply(s.areaNotDetected);
    }

    await saveUser({ ...user, areas, lastActiveAt: Date.now() });

    const translatedAreas = translateAreas(areas.join(", "), lang);
    await ctx.reply(
      s.registered.replace("{lang}", lang).replace("{areas}", translatedAreas),
      { parse_mode: "HTML", reply_markup: mainMenuKeyboard(lang) },
    );
    logger.info("User area updated via location", {
      chatId,
      areas,
      detected: !!detectedArea,
    });
  });

  // ── "Skip" button handler ──────────────────────────
  bot.hears(
    [
      getBotStrings("ru").skipLocationBtn,
      getBotStrings("en").skipLocationBtn,
      getBotStrings("he").skipLocationBtn,
      getBotStrings("ar").skipLocationBtn,
    ],
    async (ctx) => {
      const chatId = String(ctx.chat.id);
      const user = await getUser(chatId);
      if (!user) return;

      const lang = user.language as Language;
      const s = getBotStrings(lang);
      const areas = getDefaultAreas();

      await saveUser({ ...user, areas, lastActiveAt: Date.now() });

      const translatedAreas = translateAreas(areas.join(", "), lang);
      await ctx.reply(
        s.registered
          .replace("{lang}", lang)
          .replace("{areas}", translatedAreas),
        { parse_mode: "HTML", reply_markup: mainMenuKeyboard(lang) },
      );
      logger.info("User skipped location, using defaults", { chatId, areas });
    },
  );
}
