/**
 * Pre-Filter Node — noise filter + watermark tracking.
 *
 * Collects Telegram posts from Redis, applies deterministic noise filters,
 * and returns ChannelTracking with only relevant channels.
 */

import { backfillChannelPosts } from "@easyoref/gramjs";
import {
  getActiveSession,
  getChannelPosts,
  getLastUpdateTs,
} from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import { AIMessage } from "langchain";
import type { AgentStateType } from "../enrichment-graph.js";
import { buildTracking } from "../../../utils/tracking.js";

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

  const { tracking, stats } = buildTracking(
    posts,
    sessionStartTs,
    lastUpdateTs,
  );

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
