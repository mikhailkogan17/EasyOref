import { runQa } from "@easyoref/agent";
import {
  config,
  getBotStrings,
  getRedis,
  getUser,
  type Language,
} from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import type { Bot } from "grammy";

export function registerQaHandler(bot: Bot): void {
  bot.on("message:text", async (ctx) => {
    if (ctx.chat.type !== "private") return;

    const chatId = String(ctx.chat.id);

    // Skip /commands — let grammY command handlers handle them
    if (ctx.message.text.startsWith("/")) return;

    // Skip reply keyboard button presses (shelter/settings buttons)
    const btnTexts = ["ru", "en", "he", "ar"].flatMap((l) => {
      const s = getBotStrings(l as Language);
      return [s.btnShelter, s.btnSettings, s.skipLocationBtn];
    });
    if (btnTexts.includes(ctx.message.text)) return;

    const user = await getUser(chatId);
    const lang = (user?.language ?? "ru") as Language;
    const bs = getBotStrings(lang);

    if (!user) {
      await ctx.reply(bs.qaNotRegistered);
      return;
    }

    // Rate limit: qaRateLimitPerMin per user (Redis INCR + EXPIRE)
    const redis = getRedis();
    const rateLimitKey = `qa:rate:${chatId}`;
    const count = await redis.incr(rateLimitKey);
    if (count === 1) await redis.expire(rateLimitKey, 60);
    if (count > config.agent.qaRateLimitPerMin) {
      await ctx.reply(bs.qaRateLimit);
      return;
    }

    await ctx.replyWithChatAction("typing");

    try {
      const answer = await runQa(ctx.message.text, chatId);
      await ctx.reply(answer, { parse_mode: "HTML" });
    } catch (err) {
      logger.error("Q&A failed", { error: String(err), chatId });
      await ctx.reply(bs.qaError);
    }
  });
}
