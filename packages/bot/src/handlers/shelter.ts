/**
 * Shelter search handler — responds to location messages with nearest bomb shelters.
 * Safety-critical feature: available to ALL tiers (free + pro).
 */

import { fetchNearestShelters, type NearShelter } from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import type { Bot } from "grammy";

function formatShelterList(nearest: NearShelter[]): string {
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
  return `🏚 <b>Nearest shelters:</b>\n\n${lines.join("\n\n")}`;
}

export function registerShelterHandler(bot: Bot): void {
  bot.on("message:location", async (ctx) => {
    const { latitude, longitude } = ctx.message.location;
    const chatId = String(ctx.chat.id);

    logger.info("Shelter search requested", { chatId, latitude, longitude });

    // Send typing indicator while fetching
    await ctx.replyWithChatAction("find_location").catch(() => {});

    const nearest = await fetchNearestShelters(latitude, longitude);

    if (nearest.length === 0) {
      await ctx.reply(
        "No shelters found nearby in OpenStreetMap data.\n\n" +
          "Try the official Pikud HaOref shelter finder:\n" +
          "https://www.oref.org.il/NAShelters/",
        { link_preview_options: { is_disabled: true } },
      );
      return;
    }

    await ctx.reply(formatShelterList(nearest), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });
}
