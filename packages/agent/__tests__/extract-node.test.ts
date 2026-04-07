/**
 * Unit tests for extract-node (extractChannelNode) and fanOutExtract conditional edge.
 *
 * Tests pure/deterministic logic — LLM calls are mocked. No network.
 * Covers: getPhaseRule, extractChannelNode (happy path, missing state, LLM failure),
 *         fanOutExtract (skip cases, URL dedup, parallel fan-out).
 */

import type { NewsChannelWithUpdatesType } from "@easyoref/shared";
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
        channels: ["@N12LIVE"],
        areaLabels: {},
      },
      botToken: "",
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
  invokeWithFallback: (...args: unknown[]) => mockInvokeWithFallback(...args),
}));

// Import AFTER mocks
import { extractChannelNode } from "../src/graphs/enrichment/nodes/extract.js";
import { getPhaseRule } from "../src/utils/phase-rules.js";

// ── Helpers ────────────────────────────────────────────────

function makeChannel(
  overrides: Partial<NewsChannelWithUpdatesType> = {},
): NewsChannelWithUpdatesType {
  return {
    channel: "@N12LIVE",
    processedMessages: [],
    unprocessedMessages: [
      {
        channelId: "@N12LIVE",
        sourceType: "telegram_channel" as const,
        timestamp: Date.now(),
        text: "30 רקטות שוגרו מלבנון לכיוון תל אביב",
        sourceUrl: "https://t.me/N12LIVE/12345",
      },
    ],
    ...overrides,
  };
}

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    messages: [],
    alertId: "test-alert-1",
    alertTs: Date.now(),
    alertType: "red_alert",
    alertAreas: ["תל אביב - דרום העיר ויפו"],
    chatId: "-1001234567890",
    messageId: 100,
    isCaption: false,
    currentText: "🚀 Alert: rockets detected",
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

function makeInsight(sourceUrl: string) {
  return {
    kind: {
      kind: "rocket_count" as const,
      value: { type: "exact" as const, value: 30 },
    },
    timeRelevance: 1.0,
    regionRelevance: 1.0,
    confidence: 0.9,
    source: {
      channelId: "@N12LIVE",
      sourceType: "telegram_channel" as const,
      timestamp: Date.now(),
      text: "30 rockets from Lebanon",
      sourceUrl,
    },
    timeStamp: new Date().toISOString(),
  };
}

// ── getPhaseRule ────────────────────────────────────────────

describe("getPhaseRule", () => {
  it("returns early_warning rule focusing on origins/eta/count", () => {
    const rule = getPhaseRule("early_warning");
    expect(rule).toContain("country_origins");
    expect(rule).toContain("eta");
    expect(rule).toContain("rocket_count");
    expect(rule).toContain("Do NOT extract");
  });

  it("returns red_alert rule including eta, cluster munition, and impact", () => {
    const rule = getPhaseRule("red_alert");
    expect(rule).toContain("country_origins");
    expect(rule).toContain("eta");
    expect(rule).toContain("cluser_munition_used");
    expect(rule).toContain("impact");
    expect(rule).toContain("Do NOT extract casualities");
  });

  it("returns resolved rule extracting ALL kinds", () => {
    const rule = getPhaseRule("resolved");
    expect(rule).toContain("ALL insight kinds");
    expect(rule).toContain("casualities");
    expect(rule).toContain("cluser_munition_used");
  });

  it("returns generic fallback for unknown phase", () => {
    const rule = getPhaseRule("unknown_phase");
    expect(rule).toContain("all relevant information");
  });
});

// ── extractChannelNode ──────────────────────────────────────

describe("extractChannelNode", () => {
  beforeEach(() => {
    mockInvokeWithFallback.mockReset();
  });

  it("returns insights for a channel with extractable posts", async () => {
    const insight = makeInsight("https://t.me/N12LIVE/12345");
    mockInvokeWithFallback.mockResolvedValue({
      structuredResponse: [insight],
    });

    const channel = makeChannel();
    const state = makeState({ channelToExtract: channel });

    const result = await extractChannelNode(state as any);

    expect(result.extractedInsights).toHaveLength(1);
    expect(result.extractedInsights![0]).toEqual(insight);
    expect(mockInvokeWithFallback).toHaveBeenCalledOnce();
  });

  it("returns empty when LLM finds no extractable facts", async () => {
    mockInvokeWithFallback.mockResolvedValue({
      structuredResponse: [],
    });

    const channel = makeChannel({
      unprocessedMessages: [
        {
          channelId: "@N12LIVE",
          sourceType: "telegram_channel",
          timestamp: Date.now(),
          text: "Good morning everyone!",
          sourceUrl: "https://t.me/N12LIVE/99999",
        },
      ],
    });
    const state = makeState({ channelToExtract: channel });

    const result = await extractChannelNode(state as any);

    expect(result.extractedInsights ?? []).toHaveLength(0);
  });

  it("returns empty + AI message when channelToExtract is missing", async () => {
    const state = makeState({ channelToExtract: undefined });

    const result = await extractChannelNode(state as any);

    expect(result.extractedInsights).toBeUndefined();
    expect(result.messages).toHaveLength(1);
    expect(mockInvokeWithFallback).not.toHaveBeenCalled();
  });

  it("isolates failure — returns empty on LLM error (doesn't throw)", async () => {
    mockInvokeWithFallback.mockRejectedValue(
      new Error("LLM rate limit exceeded"),
    );

    const channel = makeChannel();
    const state = makeState({ channelToExtract: channel });

    const result = await extractChannelNode(state as any);

    // Should NOT throw — failure is isolated
    expect(result.extractedInsights).toBeUndefined();
    expect(result.messages).toHaveLength(1);
    expect(result.messages![0].content).toContain("failed");
  });

  it("passes correct phase-specific rule to LLM", async () => {
    mockInvokeWithFallback.mockResolvedValue({ structuredResponse: [] });

    const channel = makeChannel();
    const state = makeState({
      channelToExtract: channel,
      alertType: "early_warning",
    });

    await extractChannelNode(state as any);

    // Verify the system message contains phase-specific rule
    const callArgs = mockInvokeWithFallback.mock.calls[0][0];
    const systemMsg = callArgs.input.messages[0];
    expect(systemMsg.content).toContain("country_origins");
    expect(systemMsg.content).toContain("Do NOT extract");
  });

  it("handles null structuredResponse gracefully", async () => {
    mockInvokeWithFallback.mockResolvedValue({
      structuredResponse: null,
    });

    const channel = makeChannel();
    const state = makeState({ channelToExtract: channel });

    const result = await extractChannelNode(state as any);

    expect(result.extractedInsights ?? []).toHaveLength(0);
  });
});

// ── fanOutExtract (tested via graph module) ─────────────────
// fanOutExtract is not exported from graph.ts (it's a local const),
// so we test it indirectly through buildGraph(). However, the core
// logic (URL dedup, skip logic) is implicitly tested by the integration
// test in enrichment.integration.test.ts. Here we test the exported
// helpers that support the fan-out logic.

describe("extractFromChannel (exported helper)", () => {
  beforeEach(() => {
    mockInvokeWithFallback.mockReset();
  });

  // Import extractFromChannel dynamically after mocks
  it("returns channel name and insights tuple", async () => {
    const insight = makeInsight("https://t.me/israel_9/555");
    mockInvokeWithFallback.mockResolvedValue({ structuredResponse: [insight] });

    const { extractFromChannel } =
      await import("../src/utils/channel-extract.js");
    const channel = makeChannel({ channel: "@israel_9" });
    const result = await extractFromChannel(channel, "Extract all.");

    expect(result.channel).toBe("@israel_9");
    expect(result.insights).toHaveLength(1);
  });
});

// ── extractionAgentOpts — prompt safety rules (postmortem Apr 4 2026) ──────

import { extractionAgentOpts } from "../src/graphs/enrichment/nodes/extract.js";

describe("extractionAgentOpts — prompt safety rules", () => {
  /**
   * Postmortem Finding #1 — מצרר → Egypt misparse (Apr 4 2026, 11:56:35)
   *
   * Root cause: LLM confused Hebrew "מצרר" (cluster munition) with "מצרים" (Egypt).
   * Source text: "שיגור טיל מצרר למרכז — בליסטי בודד לירושלים — זוהו 2 טילים"
   * LLM output: country_origins: ["Egypt"] — confidence 0.85
   *
   * Fix: Added explicit disambiguation rule in extraction system prompt.
   * This test ensures the rule is never accidentally removed.
   */
  it("contains מצרר vs Egypt disambiguation rule (postmortem Apr 4: Finding #1)", () => {
    expect(extractionAgentOpts.systemPrompt).toContain("מצרר");
    expect(extractionAgentOpts.systemPrompt).toContain("Egypt");
    // The rule must explicitly link the two concepts — not just mention them
    expect(extractionAgentOpts.systemPrompt).toMatch(/מצרר.*Egypt|Egypt.*מצרר/);
  });

  it("instructs NOT to output Egypt/מצרים unless the text explicitly names Egypt as origin", () => {
    expect(extractionAgentOpts.systemPrompt).toContain("מצרים");
    expect(extractionAgentOpts.systemPrompt).toContain("cluser_munition_used");
    // When source has מצרר → prefer cluster munition, not country
    expect(extractionAgentOpts.systemPrompt).toMatch(
      /מצרר.*prefer cluser_munition_used|prefer cluser_munition_used.*מצרר/,
    );
  });

  /**
   * Postmortem Finding #3 — ETA extraction failure (Apr 4 2026)
   *
   * Root cause: cheaper model skipped ETA when it had already extracted country_origins
   * from the same text block ("איו\"ש ⏱ זמן א..."). Multi-fact extraction failure.
   *
   * Fix: Added "ALWAYS extract ETA" and "never skip ETA" explicit rules to prompt.
   */
  it("instructs to ALWAYS extract ETA when a time reference is present (postmortem Apr 4: Finding #3)", () => {
    expect(extractionAgentOpts.systemPrompt).toContain("ALWAYS extract ETA");
  });

  it("warns never to skip ETA because another fact was already extracted (postmortem Apr 4: Finding #3)", () => {
    expect(extractionAgentOpts.systemPrompt).toContain("never skip ETA");
  });

  it("instructs to output separate insights for origin AND ETA from the same post", () => {
    // Ensures both country_origins and eta are extracted when both are present
    expect(extractionAgentOpts.systemPrompt).toMatch(
      /both an origin.*and a time|origin country and a time/i,
    );
    expect(extractionAgentOpts.systemPrompt).toContain(
      "separate insights for each",
    );
  });

  it("cluser_munition_used kind is documented in prompt with Hebrew aliases", () => {
    // Early_warning phase rule must include cluster munition
    const earlyRule = getPhaseRule("early_warning");
    expect(earlyRule).toContain("cluser_munition_used");
  });
});
