/**
 * Deterministic noise filter for Telegram channel posts.
 *
 * Drops automated Kipat Barzel / Oref / Tzofar / IDF API dumps.
 * MUST NOT filter legitimate news posts in ANY language.
 */

import type { ChannelPostType, NewsMessageType } from "@easyoref/shared";

const OREF_LINK_RE = /oref\.org\.il/i;
const OREF_CHANNEL_RE = /pikud|פיקוד|oref/i;
const IDF_CHANNEL_RE = /idf|צה"?ל|tsahal/i;

/** Returns rejection reason string, or null if post is not noise. */
export function noiseReason(post: ChannelPostType): string | null {
  if (OREF_CHANNEL_RE.test(post.channel) && post.text.length > 300)
    return "oref_channel_long";
  if (OREF_LINK_RE.test(post.text)) return "oref_link";
  if ((post.text.match(/,/g) ?? []).length >= 8) return "comma_list";
  if ((post.text.match(/\(\d{1,2}:\d{2}\)/g) ?? []).length >= 2)
    return "time_pattern_list";
  if (IDF_CHANNEL_RE.test(post.channel) && post.text.length > 400)
    return "idf_channel_long";
  return null;
}

export function toNewsMessage(post: ChannelPostType): NewsMessageType {
  return {
    channelId: post.channel,
    sourceType: "telegram_channel",
    timestamp: post.ts,
    text: post.text,
    sourceUrl: post.messageUrl,
  };
}
