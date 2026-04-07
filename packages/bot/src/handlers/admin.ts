import { config, getAllUsers, setUserTier } from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import type { Bot } from "grammy";

function isAdmin(chatId: string): boolean {
  return config.adminChatIds.includes(Number(chatId));
}

export function registerAdminHandler(bot: Bot): void {
  // /grant <chatId> — upgrade user to Pro
  bot.command("grant", async (ctx) => {
    const adminId = String(ctx.chat.id);
    if (!isAdmin(adminId)) {
      await ctx.reply("Unauthorized.");
      return;
    }
    const args = ctx.match?.trim();
    if (!args) {
      await ctx.reply("Usage: /grant <chatId>");
      return;
    }
    const success = await setUserTier(args, "pro");
    if (success) {
      await ctx.reply(`✅ User ${args} upgraded to Pro.`);
      logger.info("Admin: granted pro", { adminId, targetId: args });
    } else {
      await ctx.reply(`User ${args} not found.`);
    }
  });

  // /revoke <chatId> — downgrade user to Free
  bot.command("revoke", async (ctx) => {
    const adminId = String(ctx.chat.id);
    if (!isAdmin(adminId)) {
      await ctx.reply("Unauthorized.");
      return;
    }
    const args = ctx.match?.trim();
    if (!args) {
      await ctx.reply("Usage: /revoke <chatId>");
      return;
    }
    const success = await setUserTier(args, "free");
    if (success) {
      await ctx.reply(`✅ User ${args} downgraded to Free.`);
      logger.info("Admin: revoked pro", { adminId, targetId: args });
    } else {
      await ctx.reply(`User ${args} not found.`);
    }
  });

  // /users — list all registered users
  bot.command("users", async (ctx) => {
    const adminId = String(ctx.chat.id);
    if (!isAdmin(adminId)) {
      await ctx.reply("Unauthorized.");
      return;
    }
    const allUsers = await getAllUsers();
    if (allUsers.length === 0) {
      await ctx.reply("No registered users.");
      return;
    }
    const lines = allUsers.map(
      (u) =>
        `• <code>${u.chatId}</code> — ${u.tier} — ${u.language} — ${u.areas.join(", ")}`,
    );
    await ctx.reply(
      `<b>Registered Users (${allUsers.length}):</b>\n\n${lines.join("\n")}`,
      { parse_mode: "HTML" },
    );
  });
}
