import {
  config,
  getUser,
  isValidLanguage,
  resolveCityIds,
  saveUser,
  type UserConfigType as UserConfig,
} from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import type { Bot } from "grammy";

/** Default areas from config city_ids (resolved at startup via initTranslations) */
let defaultAreas: string[] = [];

export function initDefaultAreas(): void {
  if (config.cityIds.length > 0) {
    defaultAreas = resolveCityIds(config.cityIds);
  }
}

/**
 * /start [lang] — register or update user.
 * In private chat: registers the user with their chat ID.
 * In group chat: registers the group chat ID.
 *
 * Areas default to config.city_ids (resolved Hebrew names).
 * Language defaults to "ru" or optional argument.
 *
 * Examples:
 *   /start       → register with default language (ru)
 *   /start en    → register with English
 *   /start he    → register with Hebrew
 */
export function registerStartHandler(bot: Bot): void {
  bot.command("start", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const args = ctx.match?.trim();

    // Parse optional language argument
    let lang = "ru";
    if (args && isValidLanguage(args)) {
      lang = args;
    }

    // Resolve areas: use defaults from config city_ids
    const areas =
      defaultAreas.length > 0 ? defaultAreas : ["תל אביב - דרום העיר ויפו"];

    const existing = await getUser(chatId);
    if (existing) {
      // Update language if changed, refresh lastActiveAt
      const updated: UserConfig = {
        ...existing,
        language: lang,
        lastActiveAt: Date.now(),
      };
      await saveUser(updated);
      await ctx.reply(
        `✅ Updated! Language: ${lang}, Areas: ${areas.join(", ")}`,
      );
      logger.info("User updated via /start", { chatId, lang });
      return;
    }

    // New registration
    const user: UserConfig = {
      chatId,
      language: lang,
      areas,
      tier: "free",
      registeredAt: Date.now(),
      lastActiveAt: Date.now(),
    };
    await saveUser(user);
    await ctx.reply(
      `✅ Registered! Language: ${lang}, Areas: ${areas.join(", ")}\n\nYou will receive alerts for these areas.`,
    );
    logger.info("User registered via /start", { chatId, lang, areas });
  });
}
