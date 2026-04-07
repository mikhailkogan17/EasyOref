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
    // Q&A works in private chats AND group chats (when mentioned or replied to)
    const isPrivate = ctx.chat.type === "private";
    const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";

    // In groups: only respond to direct replies to the bot or mentions
    if (isGroup) {
      const botInfo = ctx.me;
      const text = ctx.message.text ?? "";
      const isReplyToBot =
        ctx.message.reply_to_message?.from?.id === botInfo.id;
      const isMentioned =
        text.includes(`@${botInfo.username}`) ||
        (ctx.message.entities ?? []).some(
          (e) =>
            e.type === "mention" &&
            text.slice(e.offset, e.offset + e.length).toLowerCase() ===
              `@${botInfo.username?.toLowerCase()}`,
        );
      if (!isReplyToBot && !isMentioned) return;
    }

    if (!isPrivate && !isGroup) return;

    const chatId = String(ctx.chat.id);
    const userId = String(ctx.from?.id ?? ctx.chat.id);

    // Skip /commands — let grammY command handlers handle them
    if (ctx.message.text.startsWith("/")) return;

    // Skip reply keyboard button presses (shelter/settings buttons)
    const btnTexts = ["ru", "en", "he", "ar"].flatMap((l) => {
      const s = getBotStrings(l as Language);
      return [s.btnShelter, s.btnSettings, s.skipLocationBtn];
    });
    if (btnTexts.includes(ctx.message.text)) return;

    const user = await getUser(isPrivate ? chatId : userId);
    const lang = (user?.language ?? "ru") as Language;
    const bs = getBotStrings(lang);

    if (!user) {
      await ctx.reply(bs.qaNotRegistered);
      return;
    }

    // Rate limit: qaRateLimitPerMin per user (Redis INCR + EXPIRE)
    const redis = getRedis();
    const rateLimitKey = `qa:rate:${userId}`;
    const count = await redis.incr(rateLimitKey);
    if (count === 1) await redis.expire(rateLimitKey, 60);
    if (count > config.agent.qaRateLimitPerMin) {
      await ctx.reply(bs.qaRateLimit);
      return;
    }

    // Start periodic typing indicator (every 4s, Telegram typing expires after 5s)
    let typingActive = true;
    const sendTyping = async () => {
      while (typingActive) {
        try {
          await ctx.replyWithChatAction("typing");
        } catch {
          // ignore typing errors
        }
        await new Promise((r) => setTimeout(r, 4000));
      }
    };
    const typingPromise = sendTyping();

    try {
      // Status callback: sends intermediate "searching..." messages
      const statusCallback = async (message: string) => {
        try {
          await ctx.reply(message, { parse_mode: "HTML" });
        } catch {
          // ignore status message errors
        }
      };

      const answer = await runQa(
        ctx.message.text,
        isPrivate ? chatId : userId,
        statusCallback,
      );
      typingActive = false;
      await typingPromise;

      await ctx.reply(answer, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      typingActive = false;
      await typingPromise;
      logger.error("Q&A failed", { error: String(err), chatId });
      await ctx.reply(bs.qaError);
    }
  });
}
