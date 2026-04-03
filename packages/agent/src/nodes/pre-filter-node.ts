/**
 * Pre-Filter Node — noise filter + LLM channel relevance filter.
 *
 * Step 1: Deterministic noise filter (regex-based, removes garbage posts).
 * Step 2: LLM agent decides which channels contain actionable military intel.
 * Step 3: Returns filtered ChannelTracking with only relevant channels.
 */

import * as logger from "@easyoref/monitoring";
import {
  getActiveSession,
  getChannelPosts,
  getLastUpdateTs,
  type ChannelPostType,
  type ChannelTrackingType,
  type NewsChannelWithUpdatesType,
  type NewsMessageType,
} from "@easyoref/shared";
import { backfillChannelPosts } from "@easyoref/gramjs";
import {
  AIMessage,
} from "langchain";
import type { AgentStateType } from "../graph.js";

// ── Noise filter ──────────────────────────────────────────
//
// Purpose: drop automated Kipat Barzel / Oref / Tzofar / IDF API dumps.
// MUST NOT filter legitimate news posts in ANY language (Russian, Hebrew, Arabic, English).
// Specifically: no language-specific patterns (e.g. "минут" killed @Trueisrael).

const OREF_LINK_RE = /oref\.org\.il/i;
const OREF_CHANNEL_RE = /pikud|פיקוד|oref/i;
const IDF_CHANNEL_RE = /idf|צה"?ל|tsahal/i;

/** Returns rejection reason string, or null if post is not noise. */
function noiseReason(post: ChannelPostType): string | null {
  if (OREF_CHANNEL_RE.test(post.channel) && post.text.length > 300)
    return "oref_channel_long";
  if (OREF_LINK_RE.test(post.text))
    return "oref_link";
  if ((post.text.match(/,/g) ?? []).length >= 8)
    return "comma_list";
  if ((post.text.match(/\(\d{1,2}:\d{2}\)/g) ?? []).length >= 2)
    return "time_pattern_list";
  // REMOVED: /\d+\s+минут[ыа]?\b/i — was killing Russian-language channels (@Trueisrael)
  if (IDF_CHANNEL_RE.test(post.channel) && post.text.length > 400)
    return "idf_channel_long";
  return null;
}

/** Backwards-compatible boolean wrapper. */
function isNoise(post: ChannelPostType): boolean {
  return noiseReason(post) !== null;
}

function toNewsMessage(post: ChannelPostType): NewsMessageType {
  return {
    channelId: post.channel,
    sourceType: "telegram_channel",
    timestamp: post.ts,
    text: post.text,
    sourceUrl: post.messageUrl,
  };
}

/** Rejection stats: channel → reason → count, plus rejected post previews. */
export interface FilterStats {
  rejected: { channel: string; reason: string; textPreview: string }[];
  rejectedByReason: Record<string, number>;
  totalPosts: number;
  passedPosts: number;
  tooEarly: number;
}

export function buildTracking(
  posts: ChannelPostType[],
  sessionStartTs: number,
  lastUpdateTs: number,
): { tracking: ChannelTrackingType; stats: FilterStats } {
  const map = new Map<string, { previous: NewsMessageType[]; latest: NewsMessageType[] }>();
  const stats: FilterStats = {
    rejected: [],
    rejectedByReason: {},
    totalPosts: posts.length,
    passedPosts: 0,
    tooEarly: 0,
  };

  for (const post of posts) {
    const reason = noiseReason(post);
    if (reason) {
      stats.rejected.push({
        channel: post.channel,
        reason,
        textPreview: post.text.slice(0, 120),
      });
      stats.rejectedByReason[reason] = (stats.rejectedByReason[reason] ?? 0) + 1;
      continue;
    }
    if (post.ts < sessionStartTs) {
      stats.tooEarly++;
      continue;
    }
    stats.passedPosts++;
    if (!map.has(post.channel)) map.set(post.channel, { previous: [], latest: [] });
    const bucket = map.get(post.channel)!;
    const msg = toNewsMessage(post);
    if (lastUpdateTs > 0 && post.ts <= lastUpdateTs) bucket.previous.push(msg);
    else bucket.latest.push(msg);
  }

  const channelsWithUpdates: NewsChannelWithUpdatesType[] = [];
  for (const [channel, { previous, latest }] of map) {
    if (latest.length > 0) {
      channelsWithUpdates.push({
        channel,
        processedMessages: previous.sort((a, b) => a.timestamp - b.timestamp),
        unprocessedMessages: latest.sort((a, b) => a.timestamp - b.timestamp),
      });
    }
  }

  const tracking: ChannelTrackingType = {
    trackStartTimestamp: sessionStartTs,
    lastUpdateTimestamp: lastUpdateTs,
    channelsWithUpdates,
  };

  return { tracking, stats };
}

// ── Node ───────────────────────────────────────────────────

export const filterNode = async (
  state: AgentStateType,
): Promise<Partial<AgentStateType>> => {
  let posts = await getChannelPosts(state.alertId);
  const session = await getActiveSession();
  const sessionStartTs = session?.sessionStartTs ?? state.alertTs;
  const lastUpdateTs = await getLastUpdateTs();

  // Fallback: if event-based collection yielded 0 posts, try active polling
  if (posts.length === 0) {
    const backfilled = await backfillChannelPosts(sessionStartTs);
    if (backfilled > 0) {
      logger.info("pre-filter-node: fallback polling fetched posts", {
        alertId: state.alertId,
        count: backfilled,
      });
      posts = await getChannelPosts(state.alertId);
    }
  }

  if (posts.length === 0) {
    logger.info("pre-filter-node: no posts found", { alertId: state.alertId });
    return {
      messages: [new AIMessage("pre-filter-node: no posts found")],
      tracking: undefined,
    };
  }

  const { tracking, stats } = buildTracking(posts, sessionStartTs, lastUpdateTs);

  // Log rejection stats for observability
  if (stats.rejected.length > 0) {
    logger.info("pre-filter-node: noise filter rejections", {
      alertId: state.alertId,
      rejectedByReason: stats.rejectedByReason,
      rejected: stats.rejected.map((r) => ({
        channel: r.channel,
        reason: r.reason,
        preview: r.textPreview,
      })),
      tooEarly: stats.tooEarly,
      total: stats.totalPosts,
      passed: stats.passedPosts,
    });
  }

  if (tracking.channelsWithUpdates.length === 0) {
    logger.info("pre-filter-node: all posts filtered as noise", {
      alertId: state.alertId,
      totalPosts: posts.length,
      rejectedByReason: stats.rejectedByReason,
      tooEarly: stats.tooEarly,
    });
    return {
      messages: [new AIMessage("pre-filter-node: all posts filtered as noise")],
      tracking,
    };
  }

  // All non-noise channels pass through — deterministic isNoise() is sufficient.
  // LLM pre-filter was consistently rejecting valid channels with the free model
  // (returned relevantChannels: [] during real attacks). Bypassed in v1.26.0.
  const allChannels = tracking.channelsWithUpdates.map((ch) => ch.channel);

  logger.info("pre-filter-node: pass-through (deterministic filter only)", {
    alertId: state.alertId,
    totalChannels: allChannels.length,
    channels: allChannels,
    channelPreviews: tracking.channelsWithUpdates.map((ch) => ({
      channel: ch.channel,
      msgCount: ch.unprocessedMessages.length,
      firstMsgPreview: ch.unprocessedMessages[0]?.text?.slice(0, 80) ?? "",
    })),
  });

  return {
    messages: [
      new AIMessage(
        `pre-filter-node: pass-through, ${allChannels.length} channels forwarded`,
      ),
    ],
    tracking,
  };
};
