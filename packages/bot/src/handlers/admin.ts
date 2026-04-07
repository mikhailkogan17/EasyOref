import {
  config,
  getAllUsers,
  getBotStrings,
  getUser,
  setUserTier,
  type Language,
} from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import type { Bot } from "grammy";

function isAdmin(chatId: string): boolean {
  return config.adminChatIds.includes(Number(chatId));
}

function getAdminLang(chatId: string): Language {
  // Admin lang: we don't async lookup here, default to "ru"
  return "ru";
}

/**
 * Resolve a grant/revoke target to a chatId string.
 * Accepts: numeric ID, @username, t.me/username URL.
 */
async function resolveTarget(
  bot: Bot,
  input: string,
): Promise<{ chatId: string; display: string } | { error: string }> {
  const trimmed = input.trim();

  // Numeric chat ID
  if (/^-?\d+$/.test(trimmed)) {
    return { chatId: trimmed, display: trimmed };
  }

  // Extract username from @mention or t.me/ link
  let username: string | undefined;
  if (trimmed.startsWith("@")) {
    username = trimmed;
  } else {
    const match = trimmed.match(
      /(?:https?:\/\/)?t(?:elegram)?\.me\/([a-zA-Z_]\w{3,})/,
    );
    if (match) {
      username = `@${match[1]}`;
    }
  }

  if (!username) {
    return { error: "Invalid target. Use chat ID, @username, or t.me/link." };
  }

  try {
    const chat = await bot.api.getChat(username);
    return { chatId: String(chat.id), display: `${username} (${chat.id})` };
  } catch {
    return {
      error: `Could not resolve ${username}. Bot must have interacted with this user/group.`,
    };
  }
}

export function registerAdminHandler(bot: Bot): void {
  // /grant <target> — upgrade user to Pro
  bot.command("grant", async (ctx) => {
    const adminId = String(ctx.chat.id);
    if (!isAdmin(adminId)) {
      const user = await getUser(adminId);
      const lang = (user?.language ?? "ru") as Language;
      await ctx.reply(getBotStrings(lang).adminUnauthorized);
      return;
    }
    const s = getBotStrings(getAdminLang(adminId));
    const args = ctx.match?.trim();
    if (!args) {
      await ctx.reply(s.adminGrantUsage);
      return;
    }
    const resolved = await resolveTarget(bot, args);
    if ("error" in resolved) {
      await ctx.reply(resolved.error);
      return;
    }
    const success = await setUserTier(resolved.chatId, "pro");
    if (success) {
      await ctx.reply(s.adminGranted.replace("{target}", resolved.display));
      logger.info("Admin: granted pro", { adminId, target: resolved.display });
    } else {
      await ctx.reply(
        s.adminUserNotFound.replace("{target}", resolved.display),
      );
    }
  });

  // /revoke <target> — downgrade user to Free
  bot.command("revoke", async (ctx) => {
    const adminId = String(ctx.chat.id);
    if (!isAdmin(adminId)) {
      const user = await getUser(adminId);
      const lang = (user?.language ?? "ru") as Language;
      await ctx.reply(getBotStrings(lang).adminUnauthorized);
      return;
    }
    const s = getBotStrings(getAdminLang(adminId));
    const args = ctx.match?.trim();
    if (!args) {
      await ctx.reply("Usage: /revoke <chatId or @username or t.me/link>");
      return;
    }
    const resolved = await resolveTarget(bot, args);
    if ("error" in resolved) {
      await ctx.reply(resolved.error);
      return;
    }
    const success = await setUserTier(resolved.chatId, "free");
    if (success) {
      await ctx.reply(s.adminRevoked.replace("{target}", resolved.display));
      logger.info("Admin: revoked pro", { adminId, target: resolved.display });
    } else {
      await ctx.reply(
        s.adminUserNotFound.replace("{target}", resolved.display),
      );
    }
  });

  // /users — list all registered users
  bot.command("users", async (ctx) => {
    const adminId = String(ctx.chat.id);
    if (!isAdmin(adminId)) {
      const user = await getUser(adminId);
      const lang = (user?.language ?? "ru") as Language;
      await ctx.reply(getBotStrings(lang).adminUnauthorized);
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
