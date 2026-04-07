import { runQa } from "@easyoref/agent";
import { config, getRedis, getUser } from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import type { Bot } from "grammy";

export function registerQaHandler(bot: Bot): void {
  bot.on("message:text", async (ctx) => {
    if (ctx.chat.type !== "private") return;

    const chatId = String(ctx.chat.id);

    // Rate limit: qaRateLimitPerMin per user (Redis INCR + EXPIRE)
    const redis = getRedis();
    const rateLimitKey = `qa:rate:${chatId}`;
    const count = await redis.incr(rateLimitKey);
    if (count === 1) await redis.expire(rateLimitKey, 60);
    if (count > config.agent.qaRateLimitPerMin) {
      await ctx.reply("Too many questions. Please wait a minute.");
      return;
    }

    // Skip /commands — let grammY command handlers handle them
    if (ctx.message.text.startsWith("/")) return;

    const user = await getUser(chatId);
    if (!user) {
      await ctx.reply("Please use /start to register first.");
      return;
    }

    await ctx.replyWithChatAction("typing");

    try {
      const answer = await runQa(ctx.message.text, chatId);
      await ctx.reply(answer, { parse_mode: "HTML" });
    } catch (err) {
      logger.error("Q&A failed", { error: String(err), chatId });
      await ctx.reply("I couldn't process your question. Please try again.");
    }
  });
}
