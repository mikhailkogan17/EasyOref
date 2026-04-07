/**
 * Shelter search handler — responds to location messages with nearest bomb shelters.
 * Safety-critical feature: available to ALL tiers (free + pro).
 */

import {
  fetchNearestShelters,
  getBotStrings,
  getUser,
  type Language,
  type NearShelter,
} from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import { Keyboard, type Bot } from "grammy";

function formatShelterList(title: string, nearest: NearShelter[]): string {
  const lines = nearest.map((s, i) => {
    const dist =
      s.distanceKm < 1
        ? `${Math.round(s.distanceKm * 1000)}m`
        : `${s.distanceKm.toFixed(1)}km`;
    return (
      `${i + 1}. <b>${s.name}</b>${s.address ? ` — ${s.address}` : ""}\n` +
      `   📍 ${dist} (~${s.walkingMinutes} min walk)\n` +
      `   <a href="${s.googleMapsUrl}">Open in Maps</a>`
    );
  });
  return `${title}\n\n${lines.join("\n\n")}`;
}

export function registerShelterHandler(bot: Bot): void {
  // Reply keyboard "Shelter" button handler
  bot.hears(
    [
      getBotStrings("ru").btnShelter,
      getBotStrings("en").btnShelter,
      getBotStrings("he").btnShelter,
      getBotStrings("ar").btnShelter,
    ],
    async (ctx) => {
      const chatId = String(ctx.chat.id);
      const user = await getUser(chatId);
      const lang = (user?.language ?? "ru") as Language;
      const s = getBotStrings(lang);

      const locationKb = new Keyboard()
        .requestLocation(s.shareLocationBtn)
        .resized()
        .oneTime();

      await ctx.reply(s.askLocation, { reply_markup: locationKb });
    },
  );

  // Note: location messages are handled in start.ts (onboarding + area detection)
  // This handler runs AFTER start.ts location handler via next()
  bot.on("message:location", async (ctx) => {
    const { latitude, longitude } = ctx.message.location;
    const chatId = String(ctx.chat.id);
    const user = await getUser(chatId);
    const lang = (user?.language ?? "en") as Language;
    const bs = getBotStrings(lang);

    logger.info("Shelter search requested", { chatId, latitude, longitude });

    await ctx.replyWithChatAction("find_location").catch(() => {});

    const nearest = await fetchNearestShelters(latitude, longitude);

    if (nearest.length === 0) {
      await ctx.reply(bs.shelterNone, {
        link_preview_options: { is_disabled: true },
      });
      return;
    }

    await ctx.reply(formatShelterList(bs.shelterTitle, nearest), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });
}
