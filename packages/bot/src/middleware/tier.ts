import { getUser } from "@easyoref/shared";
import type { Context, NextFunction } from "grammy";

/**
 * Middleware that requires the user to have a "pro" tier.
 * Replies with an upgrade prompt and stops the handler chain for free users.
 */
export async function requirePro(
  ctx: Context,
  next: NextFunction,
): Promise<void> {
  const chatId = String(ctx.chat?.id ?? "");
  if (!chatId) return;
  const user = await getUser(chatId);
  if (user?.tier !== "pro") {
    await ctx.reply("This feature requires Pro tier. Contact the bot admin.");
    return;
  }
  return next();
}
