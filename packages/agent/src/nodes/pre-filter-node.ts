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
import {
  AIMessage,
} from "langchain";
import type { AgentStateType } from "../graph.js";

// ── Noise filter ──────────────────────────────────────────

const OREF_LINK_RE = /oref\.org\.il/i;
const OREF_CHANNEL_RE = /pikud|פיקוד|oref/i;
const IDF_CHANNEL_RE = /idf|צה"?ל|tsahal/i;

function isNoise(post: ChannelPostType): boolean {
  if (OREF_CHANNEL_RE.test(post.channel) && post.text.length > 300) return true;
  if (OREF_LINK_RE.test(post.text)) return true;
  if ((post.text.match(/,/g) ?? []).length >= 8) return true;
  if ((post.text.match(/\(\d{1,2}:\d{2}\)/g) ?? []).length >= 2) return true;
  if (/\d+\s+минут[ыа]?\b/i.test(post.text)) return true;
  if (IDF_CHANNEL_RE.test(post.channel) && post.text.length > 400) return true;
  return false;
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

export function buildTracking(
  posts: ChannelPostType[],
  sessionStartTs: number,
  lastUpdateTs: number,
): ChannelTrackingType {
  const map = new Map<string, { previous: NewsMessageType[]; latest: NewsMessageType[] }>();

  for (const post of posts) {
    if (isNoise(post)) continue;
    if (post.ts < sessionStartTs) continue;
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

  return {
    trackStartTimestamp: sessionStartTs,
    lastUpdateTimestamp: lastUpdateTs,
    channelsWithUpdates,
  };
}

// ── Node ───────────────────────────────────────────────────

export const filterNode = async (
  state: AgentStateType,
): Promise<Partial<AgentStateType>> => {
  const posts = await getChannelPosts(state.alertId);
  const session = await getActiveSession();
  const sessionStartTs = session?.sessionStartTs ?? state.alertTs;
  const lastUpdateTs = await getLastUpdateTs();

  if (posts.length === 0) {
    logger.info("pre-filter-node: no posts found", { alertId: state.alertId });
    return {
      messages: [new AIMessage("pre-filter-node: no posts found")],
      tracking: undefined,
    };
  }

  const tracking = buildTracking(posts, sessionStartTs, lastUpdateTs);

  if (tracking.channelsWithUpdates.length === 0) {
    logger.info("pre-filter-node: all posts filtered as noise", {
      alertId: state.alertId,
      totalPosts: posts.length,
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
