/**
 * Watermark-based post tracking — partitions channel posts into
 * previous (already processed) and latest (new) buckets.
 */

import type {
  ChannelPostType,
  ChannelTrackingType,
  NewsChannelWithUpdatesType,
  NewsMessageType,
} from "@easyoref/shared";
import { noiseReason, toNewsMessage } from "./noise-filter.js";

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
  const map = new Map<
    string,
    { previous: NewsMessageType[]; latest: NewsMessageType[] }
  >();
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
      stats.rejectedByReason[reason] =
        (stats.rejectedByReason[reason] ?? 0) + 1;
      continue;
    }
    if (post.ts < sessionStartTs) {
      stats.tooEarly++;
      continue;
    }
    stats.passedPosts++;
    if (!map.has(post.channel))
      map.set(post.channel, { previous: [], latest: [] });
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
    } else if (previous.length > 0) {
      // Re-surface previously-seen posts so extract-node can retry extraction.
      // URL dedup in extract-node skips posts already covered by previousInsights.
      channelsWithUpdates.push({
        channel,
        processedMessages: [],
        unprocessedMessages: previous.sort((a, b) => a.timestamp - b.timestamp),
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
