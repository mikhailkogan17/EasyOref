/**
 * Unit tests for pre-filter-node's buildTracking function.
 *
 * Tests pure deterministic logic only — no LLM, no network, no Redis.
 * Covers: noise filtering, sessionStart filter, lastUpdateTs bucketing,
 * channel deduplication, empty-input handling.
 */

import type { ChannelPostType } from "@easyoref/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────

vi.mock("@easyoref/shared", async () => {
  const actual = await vi.importActual("@easyoref/shared");
  return {
    ...actual,
    config: {
      agent: {
        filterModel: "google/gemini-2.5-flash-lite",
        filterFallbackModel: "meta-llama/llama-3.3-70b-instruct:free",
        extractModel: "google/gemini-2.5-flash-lite",
        extractFallbackModel: "meta-llama/llama-3.3-70b-instruct:free",
        apiKey: "test-key",
        channels: [],
        areaLabels: {},
      },
      botToken: "",
      logtailToken: "",
    },
    getRedis: vi.fn().mockReturnValue({ lpush: vi.fn(), expire: vi.fn() }),
    pushSessionPost: vi.fn(),
    getActiveSession: vi.fn().mockResolvedValue(null),
    getChannelPosts: vi.fn().mockResolvedValue([]),
    getLastUpdateTs: vi.fn().mockResolvedValue(0),
  };
});

vi.mock("@easyoref/shared/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// ── Import (after mocks) ──────────────────────────────────

import { buildTracking } from "../src/utils/tracking.js";

// ── Helpers ───────────────────────────────────────────────

function makePost(
  overrides: Partial<ChannelPostType> &
    Pick<ChannelPostType, "channel" | "text" | "ts">,
): ChannelPostType {
  return { messageUrl: undefined, ...overrides };
}

const SESSION_START = 1_000_000;
const LAST_UPDATE = 1_001_000;

// ─────────────────────────────────────────────────────────
// buildTracking — edge cases
// ─────────────────────────────────────────────────────────

describe("buildTracking", () => {
  it("returns empty channelsWithUpdates for empty posts", () => {
    const { tracking, stats } = buildTracking([], SESSION_START, LAST_UPDATE);
    expect(tracking.channelsWithUpdates).toHaveLength(0);
    expect(tracking.trackStartTimestamp).toBe(SESSION_START);
    expect(tracking.lastUpdateTimestamp).toBe(LAST_UPDATE);
    expect(stats.totalPosts).toBe(0);
    expect(stats.passedPosts).toBe(0);
  });

  it("filters posts before sessionStartTs", () => {
    const posts = [
      makePost({ channel: "@ch1", text: "old post", ts: SESSION_START - 1 }),
      makePost({ channel: "@ch1", text: "new post", ts: SESSION_START + 100 }),
    ];
    const { tracking, stats } = buildTracking(posts, SESSION_START, 0);
    expect(tracking.channelsWithUpdates).toHaveLength(1);
    expect(tracking.channelsWithUpdates[0].unprocessedMessages).toHaveLength(1);
    expect(tracking.channelsWithUpdates[0].unprocessedMessages[0].text).toBe(
      "new post",
    );
    expect(stats.tooEarly).toBe(1);
  });

  it("posts at exactly sessionStartTs are included", () => {
    const posts = [
      makePost({ channel: "@ch1", text: "exact start", ts: SESSION_START }),
    ];
    const { tracking } = buildTracking(posts, SESSION_START, 0);
    expect(tracking.channelsWithUpdates).toHaveLength(1);
  });

  it("buckets posts into previous/latest by lastUpdateTs", () => {
    const posts = [
      makePost({ channel: "@ch1", text: "old", ts: LAST_UPDATE - 100 }),
      makePost({ channel: "@ch1", text: "new", ts: LAST_UPDATE + 100 }),
    ];
    const { tracking } = buildTracking(posts, SESSION_START, LAST_UPDATE);
    const ch = tracking.channelsWithUpdates[0];
    expect(ch.processedMessages).toHaveLength(1);
    expect(ch.processedMessages[0].text).toBe("old");
    expect(ch.unprocessedMessages).toHaveLength(1);
    expect(ch.unprocessedMessages[0].text).toBe("new");
  });

  it("channel with only old posts is re-surfaced for retry extraction", () => {
    const posts = [
      makePost({ channel: "@ch1", text: "old only", ts: LAST_UPDATE - 100 }),
    ];
    const { tracking } = buildTracking(posts, SESSION_START, LAST_UPDATE);
    // Previously-seen posts are re-surfaced as unprocessed so extract-channel
    // can retry (URL dedup in fanOutExtract prevents double-extraction)
    expect(tracking.channelsWithUpdates).toHaveLength(1);
    expect(tracking.channelsWithUpdates[0].processedMessages).toHaveLength(0);
    expect(tracking.channelsWithUpdates[0].unprocessedMessages).toHaveLength(1);
    expect(tracking.channelsWithUpdates[0].unprocessedMessages[0].text).toBe(
      "old only",
    );
  });

  it("deduplicates channels — multiple posts from same channel are grouped", () => {
    const posts = [
      makePost({ channel: "@ch1", text: "post A", ts: LAST_UPDATE + 10 }),
      makePost({ channel: "@ch1", text: "post B", ts: LAST_UPDATE + 20 }),
      makePost({ channel: "@ch1", text: "post C", ts: LAST_UPDATE + 30 }),
    ];
    const { tracking } = buildTracking(posts, SESSION_START, LAST_UPDATE);
    expect(tracking.channelsWithUpdates).toHaveLength(1);
    expect(tracking.channelsWithUpdates[0].unprocessedMessages).toHaveLength(3);
  });

  it("unprocessedMessages are sorted ascending by timestamp", () => {
    const posts = [
      makePost({ channel: "@ch1", text: "third", ts: LAST_UPDATE + 300 }),
      makePost({ channel: "@ch1", text: "first", ts: LAST_UPDATE + 100 }),
      makePost({ channel: "@ch1", text: "second", ts: LAST_UPDATE + 200 }),
    ];
    const { tracking } = buildTracking(posts, SESSION_START, LAST_UPDATE);
    const msgs = tracking.channelsWithUpdates[0].unprocessedMessages;
    expect(msgs[0].text).toBe("first");
    expect(msgs[1].text).toBe("second");
    expect(msgs[2].text).toBe("third");
  });

  it("filters oref.org.il link posts as noise", () => {
    const posts = [
      makePost({
        channel: "@random",
        text: "see oref.org.il for details",
        ts: LAST_UPDATE + 10,
      }),
    ];
    const { tracking, stats } = buildTracking(
      posts,
      SESSION_START,
      LAST_UPDATE,
    );
    expect(tracking.channelsWithUpdates).toHaveLength(0);
    expect(stats.rejectedByReason["oref_link"]).toBe(1);
  });

  it("filters pikud channels with long text (>300 chars) as noise", () => {
    const longText = "A".repeat(301);
    const posts = [
      makePost({
        channel: "@pikudHaoref",
        text: longText,
        ts: LAST_UPDATE + 10,
      }),
    ];
    const { tracking, stats } = buildTracking(
      posts,
      SESSION_START,
      LAST_UPDATE,
    );
    expect(tracking.channelsWithUpdates).toHaveLength(0);
    expect(stats.rejectedByReason["oref_channel_long"]).toBe(1);
  });

  it("allows pikud channels with short text", () => {
    const shortText = "Alert in Tel Aviv";
    const posts = [
      makePost({
        channel: "@pikudHaoref",
        text: shortText,
        ts: LAST_UPDATE + 10,
      }),
    ];
    const { tracking } = buildTracking(posts, SESSION_START, LAST_UPDATE);
    expect(tracking.channelsWithUpdates).toHaveLength(1);
  });

  it("filters posts with 8+ commas as noise (area list)", () => {
    const commaText = "a,b,c,d,e,f,g,h,i";
    const posts = [
      makePost({ channel: "@ch1", text: commaText, ts: LAST_UPDATE + 10 }),
    ];
    const { tracking, stats } = buildTracking(
      posts,
      SESSION_START,
      LAST_UPDATE,
    );
    expect(tracking.channelsWithUpdates).toHaveLength(0);
    expect(stats.rejectedByReason["comma_list"]).toBe(1);
  });

  it("allows Russian news posts with 'минут' (flight time info)", () => {
    const posts = [
      makePost({
        channel: "@Trueisrael",
        text: "Иран запустил ракеты, через 12 минут прилёт",
        ts: LAST_UPDATE + 10,
      }),
    ];
    const { tracking } = buildTracking(posts, SESSION_START, LAST_UPDATE);
    expect(tracking.channelsWithUpdates).toHaveLength(1);
  });

  it("allows IDF channel with normal-length update (<= 400 chars)", () => {
    const posts = [
      makePost({
        channel: "@idf_telegram",
        text: 'צה"ל מודיע על יירוט מוצלח של רוב הטילים באזור המרכז',
        ts: LAST_UPDATE + 10,
      }),
    ];
    const { tracking } = buildTracking(posts, SESSION_START, LAST_UPDATE);
    expect(tracking.channelsWithUpdates).toHaveLength(1);
  });

  it("handles multiple channels independently", () => {
    const posts = [
      makePost({
        channel: "@ch1",
        text: "intel from ch1",
        ts: LAST_UPDATE + 10,
      }),
      makePost({
        channel: "@ch2",
        text: "intel from ch2",
        ts: LAST_UPDATE + 20,
      }),
    ];
    const { tracking } = buildTracking(posts, SESSION_START, LAST_UPDATE);
    expect(tracking.channelsWithUpdates).toHaveLength(2);
    const channels = tracking.channelsWithUpdates.map((c) => c.channel);
    expect(channels).toContain("@ch1");
    expect(channels).toContain("@ch2");
  });

  it("when lastUpdateTs is 0, all posts go to unprocessed (latest bucket)", () => {
    const posts = [
      makePost({ channel: "@ch1", text: "post1", ts: SESSION_START + 100 }),
      makePost({ channel: "@ch1", text: "post2", ts: SESSION_START + 200 }),
    ];
    const { tracking } = buildTracking(posts, SESSION_START, 0);
    const ch = tracking.channelsWithUpdates[0];
    expect(ch.processedMessages).toHaveLength(0);
    expect(ch.unprocessedMessages).toHaveLength(2);
  });
});

// ── filterNode (with backfill fallback) ────────────────────

const mockBackfill = vi.fn();
vi.mock("@easyoref/gramjs", () => ({
  backfillChannelPosts: (...args: unknown[]) => mockBackfill(...args),
}));

import {
  getActiveSession as _getActiveSession,
  getChannelPosts as _getChannelPosts,
  getLastUpdateTs as _getLastUpdateTs,
} from "@easyoref/shared";
import { filterNode } from "../src/graphs/enrichment/nodes/pre-filter.js";

const mockGetChannelPosts = _getChannelPosts as ReturnType<typeof vi.fn>;
const mockGetActiveSession = _getActiveSession as ReturnType<typeof vi.fn>;
const mockGetLastUpdateTs = _getLastUpdateTs as ReturnType<typeof vi.fn>;

function makeFilterState(overrides: Record<string, unknown> = {}) {
  return {
    messages: [],
    alertId: "alert-1",
    alertTs: SESSION_START,
    alertType: "red_alert" as const,
    alertAreas: ["תל אביב"],
    chatId: "-1001234567890",
    messageId: 100,
    isCaption: false,
    currentText: "Red Alert",
    tracking: undefined,
    channelToExtract: undefined,
    extractedInsights: [],
    filteredInsights: [],
    synthesizedInsights: [],
    votedResult: undefined,
    previousInsights: [],
    telegramMessages: [],
    ...overrides,
  };
}

describe("filterNode — backfill fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveSession.mockResolvedValue(null);
    mockGetLastUpdateTs.mockResolvedValue(0);
  });

  it("triggers backfill when getChannelPosts returns empty", async () => {
    // First call: empty. After backfill: has posts
    mockGetChannelPosts.mockResolvedValueOnce([]).mockResolvedValueOnce([
      makePost({
        channel: "@N12LIVE",
        text: "rockets launched",
        ts: SESSION_START + 100,
      }),
    ]);
    mockBackfill.mockResolvedValue(1);

    const result = await filterNode(makeFilterState());
    expect(mockBackfill).toHaveBeenCalledOnce();
    expect(result.tracking).toBeDefined();
    expect(result.tracking!.channelsWithUpdates).toHaveLength(1);
  });

  it("returns 'no posts found' when backfill also finds nothing", async () => {
    mockGetChannelPosts.mockResolvedValue([]);
    mockBackfill.mockResolvedValue(0);

    const result = await filterNode(makeFilterState());
    expect(mockBackfill).toHaveBeenCalledOnce();
    expect(result.tracking).toBeUndefined();
    expect(result.messages![0].content).toContain("no posts found");
  });

  it("skips backfill when posts already exist", async () => {
    mockGetChannelPosts.mockResolvedValue([
      makePost({ channel: "@N12LIVE", text: "intel", ts: SESSION_START + 100 }),
    ]);

    const result = await filterNode(makeFilterState());
    expect(mockBackfill).not.toHaveBeenCalled();
    expect(result.tracking!.channelsWithUpdates).toHaveLength(1);
  });
});
