/**
 * Pre-Filter Node — noise filter + LLM channel relevance filter.
 *
 * Step 1: Deterministic noise filter (regex-based, removes garbage posts).
 * Step 2: LLM agent decides which channels contain actionable military intel.
 * Step 3: Returns filtered ChannelTracking with only relevant channels.
 */

import {
  FilterOutput,
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
  type BaseMessage,
  HumanMessage,
  providerStrategy,
} from "langchain";
import type { AgentStateType } from "../graph.js";
import { invokeWithFallback, preFilterFallback, preFilterModel } from "../models.js";

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
    return {
      messages: [new AIMessage("pre-filter-node: no posts found")],
      tracking: undefined,
    };
  }

  const tracking = buildTracking(posts, sessionStartTs, lastUpdateTs);

  if (tracking.channelsWithUpdates.length === 0) {
    return {
      messages: [new AIMessage("pre-filter-node: all posts filtered as noise")],
      tracking,
    };
  }

  // LLM: which channels have actionable intel?
  const messages: BaseMessage[] = [
    new HumanMessage(JSON.stringify(tracking.channelsWithUpdates)),
  ];

  const agentOpts = {
    model: preFilterModel,
    responseFormat: providerStrategy(FilterOutput),
    systemPrompt: `You pre-filter Telegram channels for an Israeli missile alert system.
Given channels with their latest messages, identify which contain IMPORTANT military intel:
- Country of origin (where rockets/missiles launched from)
- Impact location (where they hit)
- Warhead type / cluster munitions
- Damage / destruction reports
- Interception reports (Iron Dome, David's Sling)
- Casualty / injury reports

IGNORE channels that ONLY contain:
- Panic, emotion or hate speech
- Rehashes of official alerts without new data
- General commentary without actionable facts

Return relevant channel names only.`,
  };

  const result = await invokeWithFallback({
    agentOpts,
    fallbackModel: preFilterFallback,
    input: { messages },
    label: "pre-filter-node",
  });
  const relevantChannels: string[] = result.structuredResponse?.relevantChannels ?? [];
  messages.push(new AIMessage(JSON.stringify(result.structuredResponse ?? {})));

  // Filter tracking to only relevant channels
  const filteredTracking: ChannelTrackingType = {
    ...tracking,
    channelsWithUpdates: tracking.channelsWithUpdates.filter((ch) =>
      relevantChannels.includes(ch.channel),
    ),
  };

  return {
    messages,
    tracking: filteredTracking,
  };
};
