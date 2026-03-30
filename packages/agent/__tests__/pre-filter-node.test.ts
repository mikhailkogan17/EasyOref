/**
 * Unit tests for pre-filter-node's buildTracking function.
 *
 * Tests pure deterministic logic only — no LLM, no network, no Redis.
 * Covers: noise filtering, sessionStart filter, lastUpdateTs bucketing,
 * channel deduplication, empty-input handling.
 */

import type { ChannelPostType } from "@easyoref/shared";
import { describe, expect, it, vi } from "vitest";

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
        mcpTools: false,
        clarifyFetchCount: 3,
        confidenceThreshold: 0.6,
        channels: [],
        areaLabels: {},
      },
      botToken: "",
      areas: ["תל אביב"],
      language: "ru",
      orefApiUrl: "https://mock.oref.api/alerts",
      orefHistoryUrl: "",
      logtailToken: "",
    },
    getRedis: vi.fn().mockReturnValue({ lpush: vi.fn(), expire: vi.fn() }),
    pushSessionPost: vi.fn(),
    getActiveSession: vi.fn().mockResolvedValue(null),
    getChannelPosts: vi.fn().mockResolvedValue([]),
    getLastUpdateTs: vi.fn().mockResolvedValue(0),
  };
});

vi.mock("@easyoref/monitoring", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// ── Import (after mocks) ──────────────────────────────────

import { buildTracking } from "../src/nodes/pre-filter-node.js";

// ── Helpers ───────────────────────────────────────────────

function makePost(
  overrides: Partial<ChannelPostType> & Pick<ChannelPostType, "channel" | "text" | "ts">,
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
    const result = buildTracking([], SESSION_START, LAST_UPDATE);
    expect(result.channelsWithUpdates).toHaveLength(0);
    expect(result.trackStartTimestamp).toBe(SESSION_START);
    expect(result.lastUpdateTimestamp).toBe(LAST_UPDATE);
  });

  it("filters posts before sessionStartTs", () => {
    const posts = [
      makePost({ channel: "@ch1", text: "old post", ts: SESSION_START - 1 }),
      makePost({ channel: "@ch1", text: "new post", ts: SESSION_START + 100 }),
    ];
    const result = buildTracking(posts, SESSION_START, 0);
    expect(result.channelsWithUpdates).toHaveLength(1);
    expect(result.channelsWithUpdates[0].unprocessedMessages).toHaveLength(1);
    expect(result.channelsWithUpdates[0].unprocessedMessages[0].text).toBe("new post");
  });

  it("posts at exactly sessionStartTs are included", () => {
    const posts = [makePost({ channel: "@ch1", text: "exact start", ts: SESSION_START })];
    const result = buildTracking(posts, SESSION_START, 0);
    expect(result.channelsWithUpdates).toHaveLength(1);
  });

  it("buckets posts into previous/latest by lastUpdateTs", () => {
    const posts = [
      makePost({ channel: "@ch1", text: "old", ts: LAST_UPDATE - 100 }),
      makePost({ channel: "@ch1", text: "new", ts: LAST_UPDATE + 100 }),
    ];
    const result = buildTracking(posts, SESSION_START, LAST_UPDATE);
    const ch = result.channelsWithUpdates[0];
    expect(ch.processedMessages).toHaveLength(1);
    expect(ch.processedMessages[0].text).toBe("old");
    expect(ch.unprocessedMessages).toHaveLength(1);
    expect(ch.unprocessedMessages[0].text).toBe("new");
  });

  it("channel with only old posts (no new) is excluded", () => {
    const posts = [
      makePost({ channel: "@ch1", text: "old only", ts: LAST_UPDATE - 100 }),
    ];
    const result = buildTracking(posts, SESSION_START, LAST_UPDATE);
    // No latest messages → channel excluded
    expect(result.channelsWithUpdates).toHaveLength(0);
  });

  it("deduplicates channels — multiple posts from same channel are grouped", () => {
    const posts = [
      makePost({ channel: "@ch1", text: "post A", ts: LAST_UPDATE + 10 }),
      makePost({ channel: "@ch1", text: "post B", ts: LAST_UPDATE + 20 }),
      makePost({ channel: "@ch1", text: "post C", ts: LAST_UPDATE + 30 }),
    ];
    const result = buildTracking(posts, SESSION_START, LAST_UPDATE);
    expect(result.channelsWithUpdates).toHaveLength(1);
    expect(result.channelsWithUpdates[0].unprocessedMessages).toHaveLength(3);
  });

  it("unprocessedMessages are sorted ascending by timestamp", () => {
    const posts = [
      makePost({ channel: "@ch1", text: "third", ts: LAST_UPDATE + 300 }),
      makePost({ channel: "@ch1", text: "first", ts: LAST_UPDATE + 100 }),
      makePost({ channel: "@ch1", text: "second", ts: LAST_UPDATE + 200 }),
    ];
    const result = buildTracking(posts, SESSION_START, LAST_UPDATE);
    const msgs = result.channelsWithUpdates[0].unprocessedMessages;
    expect(msgs[0].text).toBe("first");
    expect(msgs[1].text).toBe("second");
    expect(msgs[2].text).toBe("third");
  });

  it("filters oref.org.il link posts as noise", () => {
    const posts = [
      makePost({ channel: "@random", text: "see oref.org.il for details", ts: LAST_UPDATE + 10 }),
    ];
    const result = buildTracking(posts, SESSION_START, LAST_UPDATE);
    expect(result.channelsWithUpdates).toHaveLength(0);
  });

  it("filters pikud channels with long text (>300 chars) as noise", () => {
    const longText = "A".repeat(301);
    const posts = [
      makePost({ channel: "@pikudHaoref", text: longText, ts: LAST_UPDATE + 10 }),
    ];
    const result = buildTracking(posts, SESSION_START, LAST_UPDATE);
    expect(result.channelsWithUpdates).toHaveLength(0);
  });

  it("allows pikud channels with short text", () => {
    const shortText = "Alert in Tel Aviv";
    const posts = [
      makePost({ channel: "@pikudHaoref", text: shortText, ts: LAST_UPDATE + 10 }),
    ];
    const result = buildTracking(posts, SESSION_START, LAST_UPDATE);
    expect(result.channelsWithUpdates).toHaveLength(1);
  });

  it("filters posts with 8+ commas as noise (area list)", () => {
    const commaText = "a,b,c,d,e,f,g,h,i";
    const posts = [
      makePost({ channel: "@ch1", text: commaText, ts: LAST_UPDATE + 10 }),
    ];
    const result = buildTracking(posts, SESSION_START, LAST_UPDATE);
    expect(result.channelsWithUpdates).toHaveLength(0);
  });

  it("handles multiple channels independently", () => {
    const posts = [
      makePost({ channel: "@ch1", text: "intel from ch1", ts: LAST_UPDATE + 10 }),
      makePost({ channel: "@ch2", text: "intel from ch2", ts: LAST_UPDATE + 20 }),
    ];
    const result = buildTracking(posts, SESSION_START, LAST_UPDATE);
    expect(result.channelsWithUpdates).toHaveLength(2);
    const channels = result.channelsWithUpdates.map((c) => c.channel);
    expect(channels).toContain("@ch1");
    expect(channels).toContain("@ch2");
  });

  it("when lastUpdateTs is 0, all posts go to unprocessed (latest bucket)", () => {
    const posts = [
      makePost({ channel: "@ch1", text: "post1", ts: SESSION_START + 100 }),
      makePost({ channel: "@ch1", text: "post2", ts: SESSION_START + 200 }),
    ];
    const result = buildTracking(posts, SESSION_START, 0);
    const ch = result.channelsWithUpdates[0];
    expect(ch.processedMessages).toHaveLength(0);
    expect(ch.unprocessedMessages).toHaveLength(2);
  });
});
