/**
 * Snapshot tests for extract-node and synthesize-node.
 *
 * Golden input/output pairs that catch unexpected output shape changes.
 * LLM calls are mocked — no network. Uses vitest inline snapshots.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────

const mockInvokeWithFallback = vi.fn();

vi.mock("@easyoref/shared", async () => {
  const actual = await vi.importActual("@easyoref/shared");
  return {
    ...actual,
    config: {
      agent: {
        filterModel: "test-filter-model",
        filterFallbackModel: "test-filter-fallback",
        extractModel: "test-extract-model",
        extractFallbackModel: "test-extract-fallback",
        apiKey: "test-key",
        channels: ["@N12LIVE", "@yediotnews25"],
        areaLabels: {},
      },
      botToken: "",
      orefApiUrl: "https://mock.oref.api/alerts",
      orefHistoryUrl: "",
      logtailToken: "",
    },
    getRedis: vi.fn().mockReturnValue({ lpush: vi.fn(), expire: vi.fn() }),
    pushSessionPost: vi.fn(),
    pushChannelPost: vi.fn(),
    getActiveSession: vi.fn().mockResolvedValue(null),
    getChannelPosts: vi.fn().mockResolvedValue([]),
    getEnrichment: vi.fn().mockResolvedValue(null),
    saveEnrichment: vi.fn(),
    getCachedExtractions: vi.fn().mockResolvedValue(new Map()),
    saveCachedExtractions: vi.fn(),
    getLastUpdateTs: vi.fn().mockResolvedValue(0),
    setLastUpdateTs: vi.fn(),
    getVotedInsights: vi.fn().mockResolvedValue([]),
    saveVotedInsights: vi.fn(),
  };
});

vi.mock("@easyoref/shared/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../src/models.js", () => ({
  extractModel: { model: "test-extract" },
  extractFallback: { model: "test-extract-fallback" },
  preFilterModel: { model: "test-synthesize" },
  preFilterFallback: { model: "test-synthesize-fallback" },
  invokeWithFallback: (...args: unknown[]) => mockInvokeWithFallback(...args),
}));

// ── Imports (after mocks) ──────────────────────────────────

import { extractChannelNode } from "../src/graphs/enrichment/nodes/extract.js";
import { synthesizeNode } from "../src/graphs/enrichment/nodes/synthesize.js";

// ── Fixtures ───────────────────────────────────────────────

const FIXED_TS = 1712000000000;
const FIXED_ISO = new Date(FIXED_TS).toISOString();

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    messages: [],
    alertId: "snap-alert-1",
    alertTs: FIXED_TS,
    alertType: "red_alert",
    alertAreas: ["תל אביב - דרום העיר ויפו"],
    chatId: "-100999",
    messageId: 200,
    isCaption: false,
    currentText: "🔴 Red Alert: תל אביב",
    tracking: undefined,
    channelToExtract: undefined,
    extractedInsights: [],
    filteredInsights: [],
    votedResult: undefined,
    previousInsights: [],
    synthesizedInsights: [],
    telegramMessages: [],
    ...overrides,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Extract-node snapshots
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("extract-node snapshots", () => {
  beforeEach(() => {
    mockInvokeWithFallback.mockReset();
  });

  it("happy path — multi-insight extraction from one channel", async () => {
    const llmResponse = [
      {
        kind: { kind: "country_origins", value: ["Lebanon"] },
        timeRelevance: 0.95,
        regionRelevance: 0.9,
        confidence: 0.85,
        source: {
          channelId: "@N12LIVE",
          sourceType: "telegram_channel",
          timestamp: FIXED_TS,
          text: "30 רקטות שוגרו מלבנון",
          sourceUrl: "https://t.me/N12LIVE/12345",
        },
        timeStamp: FIXED_ISO,
      },
      {
        kind: { kind: "rocket_count", value: { type: "exact", value: 30 } },
        timeRelevance: 0.95,
        regionRelevance: 0.9,
        confidence: 0.88,
        source: {
          channelId: "@N12LIVE",
          sourceType: "telegram_channel",
          timestamp: FIXED_TS,
          text: "30 רקטות שוגרו מלבנון",
          sourceUrl: "https://t.me/N12LIVE/12345",
        },
        timeStamp: FIXED_ISO,
      },
    ];

    mockInvokeWithFallback.mockResolvedValue({
      structuredResponse: llmResponse,
    });

    const state = baseState({
      channelToExtract: {
        channel: "@N12LIVE",
        processedMessages: [],
        unprocessedMessages: [
          {
            channelId: "@N12LIVE",
            sourceType: "telegram_channel",
            timestamp: FIXED_TS,
            text: "30 רקטות שוגרו מלבנון לכיוון תל אביב",
            sourceUrl: "https://t.me/N12LIVE/12345",
          },
        ],
      },
    });

    const result = await extractChannelNode(state as any);

    expect(result.extractedInsights).toHaveLength(2);
    expect(result.extractedInsights).toMatchSnapshot();
  });

  it("empty LLM response — returns zero insights", async () => {
    mockInvokeWithFallback.mockResolvedValue({
      structuredResponse: [],
    });

    const state = baseState({
      channelToExtract: {
        channel: "@yediotnews25",
        processedMessages: [],
        unprocessedMessages: [
          {
            channelId: "@yediotnews25",
            sourceType: "telegram_channel",
            timestamp: FIXED_TS,
            text: "חדשות כלליות",
            sourceUrl: "https://t.me/yediotnews25/999",
          },
        ],
      },
    });

    const result = await extractChannelNode(state as any);

    expect(result.extractedInsights).toEqual([]);
    expect(result.messages).toHaveLength(1);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Synthesize-node snapshots
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("synthesize-node snapshots", () => {
  beforeEach(() => {
    mockInvokeWithFallback.mockReset();
  });

  it("full synthesis — origin + eta + rocket_count → 3 synthesized insights", async () => {
    const makeInsight = (kindObj: Record<string, unknown>, conf = 0.9) => ({
      kind: kindObj,
      source: {
        channelId: "@N12LIVE",
        sourceType: "telegram_channel",
        timestamp: FIXED_TS,
        text: "test",
        sourceUrl: "https://t.me/N12LIVE/12345",
      },
      timeRelevance: 0.9,
      regionRelevance: 0.9,
      confidence: conf,
      sourceTrust: 0.8,
      timeStamp: FIXED_ISO,
      isValid: true,
      extractionReason: "test",
      insightLocation: undefined,
    });

    mockInvokeWithFallback.mockResolvedValue({
      structuredResponse: {
        fields: [
          {
            key: "origin",
            value: { ru: "Ливан", en: "Lebanon", he: "לבנון", ar: "لبنان" },
          },
          {
            key: "eta",
            value: { ru: "~2 мин", en: "~2 min", he: "~2 דק'", ar: "~2 دقيقة" },
          },
          {
            key: "rocket_count",
            value: { ru: "30", en: "30", he: "30", ar: "30" },
          },
        ],
      },
    });

    const state = baseState({
      filteredInsights: [
        makeInsight({ kind: "country_origins", value: ["Lebanon"] }),
        makeInsight({ kind: "eta", value: "~2 min" }),
        makeInsight({ kind: "rocket_count", value: { type: "exact", value: 30 } }),
      ],
    });

    const result = await synthesizeNode(state as any);

    expect(result.synthesizedInsights).toHaveLength(3);
    expect(result.synthesizedInsights!.map((i) => i.key)).toEqual([
      "origin",
      "eta",
      "rocket_count",
    ]);
    expect(result.synthesizedInsights).toMatchSnapshot();
    expect(result.votedResult).toBeDefined();
    expect(Object.keys(result.votedResult!.consensus)).toMatchSnapshot();
  });

  it("empty consensus — returns empty array, no LLM call", async () => {
    const state = baseState({ filteredInsights: [] });

    const result = await synthesizeNode(state as any);

    expect(result.synthesizedInsights).toEqual([]);
    expect(mockInvokeWithFallback).not.toHaveBeenCalled();
    expect(result.votedResult).toBeDefined();
    expect(result.messages).toHaveLength(1);
  });

  it("guardrails reject overlong field — only valid insights survive", async () => {
    const makeInsight = (kindObj: Record<string, unknown>, conf = 0.9) => ({
      kind: kindObj,
      source: {
        channelId: "@N12LIVE",
        sourceType: "telegram_channel",
        timestamp: FIXED_TS,
        text: "test",
        sourceUrl: "https://t.me/N12LIVE/12345",
      },
      timeRelevance: 0.9,
      regionRelevance: 0.9,
      confidence: conf,
      sourceTrust: 0.8,
      timeStamp: FIXED_ISO,
      isValid: true,
      extractionReason: "test",
      insightLocation: undefined,
    });

    const longValue = "x".repeat(600);

    mockInvokeWithFallback.mockResolvedValue({
      structuredResponse: {
        fields: [
          {
            key: "origin",
            value: { ru: "Ливан", en: "Lebanon", he: "לבנון", ar: "لبنان" },
          },
          {
            key: "eta",
            value: { ru: longValue, en: longValue, he: longValue, ar: longValue },
          },
        ],
      },
    });

    const state = baseState({
      filteredInsights: [
        makeInsight({ kind: "country_origins", value: ["Lebanon"] }),
        makeInsight({ kind: "eta", value: "~2 min" }),
      ],
    });

    const result = await synthesizeNode(state as any);

    // Only origin passes — eta rejected by guardrails (too long)
    expect(result.synthesizedInsights).toHaveLength(1);
    expect(result.synthesizedInsights![0]!.key).toBe("origin");
  });
});
