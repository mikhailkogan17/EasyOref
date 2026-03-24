/**
 * Filter Node — deterministic pre-filters + LLM channel relevance.
 */

import * as logger from "@easyoref/monitoring";
import {
  type ChannelPost,
  type ChannelTracking,
  type ChannelWithUpdates,
  type TrackedMessage,
} from "@easyoref/shared";
import {
  config,
  getActiveSession,
  getChannelPosts,
  getEnrichmentData,
  getLastUpdateTs,
} from "@easyoref/shared";
import type { AgentStateType } from "../graph.js";
import { createAgent, providerStrategy } from "langchain";
import { filterModel } from "../models.js";
import { FilterOutputSchema } from "@easyoref/shared";

export const filterAgent = createAgent({
  model: filterModel,
  responseFormat: providerStrategy(FilterOutputSchema),
  systemPrompt: `You pre-filter Telegram channels for an Israeli missile alert system.
Given channels with their latest messages, identify which contain IMPORTANT military intel:
- Country of origin (where rockets/missiles launched from)
- Impact location (where they hit)
- Warhead type / cassette munitions
- Damage / destruction reports
- Interception reports (Iron Dome, David's Sling)
- Casualty / injury reports

IGNORE channels that only contain:
- Panic, speculation, or unverified rumors
- Rehashes of official alerts without new data
- General commentary without actionable facts

Return relevant channel names.`,
});

const OREF_LINK_PATTERN = /oref\.org\.il/i;
const OREF_CHANNEL_PATTERN = /pikud|פיקוד|oref/i;
const IDF_CHANNEL_PATTERN = /idf|צה"?ל|tsahal/i;

function isNoise(post: ChannelPost): boolean {
  if (OREF_CHANNEL_PATTERN.test(post.channel) && post.text.length > 300) return true;
  if (OREF_LINK_PATTERN.test(post.text)) return true;
  const commaCount = (post.text.match(/,/g) || []).length;
  if (commaCount >= 8) return true;
  const timeParenCount = (post.text.match(/\(\d{1,2}:\d{2}\)/g) || []).length;
  if (timeParenCount >= 2) return true;
  if (/\d+\s+минут[ыа]?\b/i.test(post.text)) return true;
  if (IDF_CHANNEL_PATTERN.test(post.channel) && post.text.length > 400) return true;
  return false;
}

function toTrackedMessage(post: ChannelPost): TrackedMessage {
  return {
    timestamp: post.ts,
    text: post.text,
    url: post.messageUrl,
    channel: post.channel,
  };
}

function buildChannelTracking(
  posts: ChannelPost[],
  sessionStartTs: number,
  lastUpdateTs: number,
): ChannelTracking {
  const channelMap = new Map<string, { previous: TrackedMessage[]; latest: TrackedMessage[] }>();

  for (const post of posts) {
    if (isNoise(post)) continue;
    if (post.ts < sessionStartTs) continue;

    if (!channelMap.has(post.channel)) {
      channelMap.set(post.channel, { previous: [], latest: [] });
    }
    const bucket = channelMap.get(post.channel)!;
    const trackedMessage = toTrackedMessage(post);

    if (lastUpdateTs > 0 && post.ts <= lastUpdateTs) {
      bucket.previous.push(trackedMessage);
    } else {
      bucket.latest.push(trackedMessage);
    }
  }

  const channelsWithUpdates: ChannelWithUpdates[] = [];
  for (const [channel, { previous, latest }] of channelMap) {
    if (latest.length > 0) {
      channelsWithUpdates.push({
        channel,
        prevTrackedMessages: previous.sort((a, b) => a.timestamp - b.timestamp),
        lastTrackedMessages: latest.sort((a, b) => a.timestamp - b.timestamp),
      });
    }
  }

  return {
    trackStartTimestamp: sessionStartTs,
    lastUpdateTimestamp: lastUpdateTs,
    channelsWithUpdates: channelsWithUpdates,
  };
}

export const filterNode = async (
  state: AgentStateType,
): Promise<Partial<AgentStateType>> => {
  const posts = await getChannelPosts(state.alertId);
  const previousEnrichment = await getEnrichmentData();
  const session = await getActiveSession();
  const sessionStartTs = session?.sessionStartTs ?? state.alertTs;
  const lastUpdateTs = await getLastUpdateTs();

  if (posts.length === 0) {
    logger.info("Agent: no posts", { alertId: state.alertId });
    return { tracking: undefined, previousEnrichment };
  }

  const tracking = buildChannelTracking(posts, sessionStartTs, lastUpdateTs);

  logger.info("Agent: channel tracking", {
    alertId: state.alertId,
    totalPosts: posts.length,
    channelsWithUpdates: tracking.channelsWithUpdates.length,
    totalNewPosts: tracking.channelsWithUpdates.reduce(
      (total, channel) => total + channel.lastTrackedMessages.length,
      0,
    ),
  });

  return { tracking, previousEnrichment };
};
