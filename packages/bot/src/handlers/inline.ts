import { runQa } from "@easyoref/agent";
import { getActiveSession, getUser } from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import type { Bot } from "grammy";
import type { InlineQueryResultArticle } from "grammy/types";

export function registerInlineHandler(bot: Bot): void {
  bot.on("inline_query", async (ctx) => {
    const query = ctx.inlineQuery.query.trim();
    const results: InlineQueryResultArticle[] = [];

    try {
      if (!query) {
        // Status widget — show current alert status from Redis
        const session = await getActiveSession();

        if (session) {
          const phase = session.phase;
          const areas = session.alertAreas.slice(0, 3).join(", ");
          const time = new Date(session.latestAlertTs).toLocaleTimeString(
            "he-IL",
            {
              hour: "2-digit",
              minute: "2-digit",
              timeZone: "Asia/Jerusalem",
            },
          );
          results.push({
            type: "article",
            id: "current_status",
            title: `\u{1F6A8} Active Alert (${phase}) — ${time}`,
            description: areas,
            input_message_content: {
              message_text: `<b>\u{1F6A8} Active Alert</b>\nPhase: ${phase}\nTime: ${time}\nAreas: ${areas}`,
              parse_mode: "HTML",
            },
          });
        } else {
          results.push({
            type: "article",
            id: "no_alerts",
            title: "\u2705 No Active Alerts",
            description: "All clear",
            input_message_content: {
              message_text:
                "<b>\u2705 No Active Alerts</b>\nEasyOref is monitoring for threats.",
              parse_mode: "HTML",
            },
          });
        }
      } else {
        // Q&A — run the same QA graph (no status callback for inline)
        const chatId = String(ctx.from.id);
        const user = await getUser(chatId);
        if (user) {
          const answer = await runQa(query, chatId);
          const preview = answer.slice(0, 50) + (answer.length > 50 ? "…" : "");
          results.push({
            type: "article",
            id: "qa_answer",
            title: preview,
            description: answer.slice(0, 100),
            input_message_content: {
              message_text: answer,
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
            },
          });
        } else {
          results.push({
            type: "article",
            id: "not_registered",
            title: "Not registered",
            description: "Use /start to register",
            input_message_content: {
              message_text: "Please start the bot first: @easyorefbot",
            },
          });
        }
      }
    } catch (err) {
      logger.error("Inline query failed", {
        error: String(err),
        query: query.slice(0, 100),
      });
      results.push({
        type: "article",
        id: "error",
        title: "Error",
        description: "Could not process query",
        input_message_content: {
          message_text: "An error occurred. Please try again.",
        },
      });
    }

    await ctx.answerInlineQuery(results, { cache_time: 30 });
  });
}
