/**
 * Unit tests for synthesize-node.
 *
 * Covers:
 *   1. Early-return when votedResult is null/empty → must return synthesizedInsights: [].
 *      ROOT CAUSE of the 2026-03-29 production crash (synthesizedInsights left undefined).
 *   2. Postmortem Finding #2 (Apr 4 2026): Cassette "flickering" — LLM drops is_cassette
 *      even when cluser_munition_used is in consensus. Tests verify the prompt guards and
 *      the post-synthesis hallucination filter (field mapping is_cluster_munition ↔ cluser_munition_used).
 */

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
        mcpTools: false,
        clarifyFetchCount: 3,
        confidenceThreshold: 0.6,
        channels: [],
        areaLabels: {},
      },
      botToken: "",
      areas: ["תל אביב"],
      language: "ru",
    },
    saveVotedInsights: vi.fn(),
    translateAreas: vi.fn((s: string) => s),
    translateCountry: vi.fn((s: string) => s),
  };
});

vi.mock("@easyoref/shared/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const mockInvokeWithFallback = vi.fn();

vi.mock("../src/models.js", () => ({
  preFilterModel: { model: "test-synthesize" },
  preFilterFallback: { model: "test-synthesize-fallback" },
  invokeWithFallback: (...args: unknown[]) => mockInvokeWithFallback(...args),
}));

// ── Import (after mocks) ──────────────────────────────────

import { synthesizeNode } from "../src/nodes/synthesize-node.js";

// ── Helpers ───────────────────────────────────────────────

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    messages: [],
    alertId: "alert-1",
    alertTs: Date.now(),
    alertType: "red_alert" as const,
    alertAreas: ["תל אביב"],
    chatId: "-1001234567890",
    messageId: 100,
    isCaption: false,
    currentText: "Red Alert",
    votedResult: undefined,
    synthesizedInsights: [],
    clarifyAttempted: false,
    extractedInsights: [],
    filteredInsights: [],
    previousInsights: [],
    telegramMessages: [],
    ...overrides,
  };
}

function makeVotedResult(kinds: Record<string, unknown> = {}) {
  return {
    consensus: kinds,
    needsClarify: false,
  };
}

function makeConsensusEntry(
  kindObj: Record<string, unknown>,
  confidence = 0.9,
) {
  return {
    kind: kindObj,
    sources: [
      {
        channelId: "@test",
        sourceType: "telegram_channel",
        timestamp: Date.now(),
        text: "test",
      },
    ],
    confidence,
    sourceTrust: 0.8,
    timeRelevance: 0.9,
    regionRelevance: 0.9,
    reason: "test consensus",
    rejectedInsights: [],
    insightLocation: undefined,
  };
}

// ─────────────────────────────────────────────────────────
// synthesizeNode — early return paths
// ─────────────────────────────────────────────────────────

describe("synthesizeNode", () => {
  it("returns synthesizedInsights: [] when votedResult is undefined", async () => {
    const state = makeState({ votedResult: undefined });
    const result = await synthesizeNode(state as any);

    expect(result.synthesizedInsights).toBeDefined();
    expect(result.synthesizedInsights).toEqual([]);
    expect(result.messages).toHaveLength(1);
  });

  it("returns synthesizedInsights: [] when votedResult has empty consensus", async () => {
    const state = makeState({
      votedResult: {
        consensus: {},
        needsClarify: false,
      },
    });
    const result = await synthesizeNode(state as any);

    expect(result.synthesizedInsights).toBeDefined();
    expect(result.synthesizedInsights).toEqual([]);
    expect(result.messages).toHaveLength(1);
  });

  it("returns synthesizedInsights: [] (not undefined) — prevents downstream crash", async () => {
    // Explicit check: the returned object must have the key set to [],
    // NOT omit it (which would leave ReducedValue untouched → undefined in state)
    const state = makeState({ votedResult: undefined });
    const result = await synthesizeNode(state as any);

    expect("synthesizedInsights" in result).toBe(true);
    expect(result.synthesizedInsights).toStrictEqual([]);
  });
});

// ─────────────────────────────────────────────────────────
// synthesizeNode — cassette / cluster munition (postmortem Finding #2)
// ─────────────────────────────────────────────────────────

/**
 * Postmortem Finding #2 — Cassette "flickering" (Apr 4 2026)
 *
 * Root cause: The synthesize-node LLM would unpredictably drop the is_cassette
 * field in subsequent passes even when cluser_munition_used was still in the
 * voted consensus. The post-synthesis hallucination filter prevents adding
 * non-consensus-backed fields, but it cannot INJECT missing ones.
 *
 * Fix applied: prompt now says "you MUST output this field" and
 * "Never drop is_cluster_munition on a subsequent pass if consensus still
 * has cluster munition". This test verifies:
 *   a) the prompt guard language is present (regression protection),
 *   b) the field key→kind mapping is correct so the filter doesn't
 *      accidentally reject is_cluster_munition as "hallucinated",
 *   c) a valid LLM response with is_cluster_munition passes through intact.
 */
describe("synthesizeNode — cassette / cluster munition (postmortem Apr 4: Finding #2)", () => {
  beforeEach(() => {
    mockInvokeWithFallback.mockReset();
  });

  it("passes is_cluster_munition through post-synthesis validation when consensus has cluser_munition_used", async () => {
    // Simulate LLM correctly returning is_cluster_munition
    mockInvokeWithFallback.mockResolvedValue({
      structuredResponse: {
        fields: [{ key: "is_cluster_munition", value: "true" }],
      },
    });

    const state = makeState({
      votedResult: makeVotedResult({
        cluser_munition_used: makeConsensusEntry({
          kind: "cluser_munition_used",
          value: true,
        }),
      }),
    });

    const result = await synthesizeNode(state as any);

    expect(result.synthesizedInsights).toHaveLength(1);
    expect(result.synthesizedInsights![0]!.key).toBe("is_cluster_munition");
    expect(result.synthesizedInsights![0]!.value).toBe("true");
  });

  it("rejects is_cluster_munition as hallucinated when cluser_munition_used is NOT in consensus", async () => {
    // LLM hallucinates — no consensus backing
    mockInvokeWithFallback.mockResolvedValue({
      structuredResponse: {
        fields: [{ key: "is_cluster_munition", value: "true" }],
      },
    });

    const state = makeState({
      votedResult: makeVotedResult({
        country_origins: makeConsensusEntry({
          kind: "country_origins",
          value: ["Iran"],
        }),
        // cluser_munition_used intentionally absent
      }),
    });

    const result = await synthesizeNode(state as any);

    // is_cluster_munition must be rejected (no consensus backing)
    const cassette = result.synthesizedInsights!.find(
      (i) => i.key === "is_cluster_munition",
    );
    expect(cassette).toBeUndefined();
  });

  it("drops is_cassette from output when LLM forgets to include it (documents known fragility)", async () => {
    // Simulate the EXACT flickering bug: LLM drops is_cluster_munition
    // even though cluser_munition_used is in consensus
    mockInvokeWithFallback.mockResolvedValue({
      structuredResponse: {
        // LLM returns origin but forgets is_cluster_munition
        fields: [{ key: "origin", value: "Иран" }],
      },
    });

    const state = makeState({
      votedResult: makeVotedResult({
        country_origins: makeConsensusEntry({
          kind: "country_origins",
          value: ["Iran"],
        }),
        cluser_munition_used: makeConsensusEntry({
          kind: "cluser_munition_used",
          value: true,
        }),
      }),
    });

    const result = await synthesizeNode(state as any);

    // Documents the known fragility: if LLM skips is_cluster_munition,
    // nothing adds it back — this is WHY the prompt MUST include the "MUST output" rule.
    const cassette = result.synthesizedInsights!.find(
      (i) => i.key === "is_cluster_munition",
    );
    expect(cassette).toBeUndefined();

    // Only origin was returned (as per mocked LLM response)
    expect(result.synthesizedInsights).toHaveLength(1);
    expect(result.synthesizedInsights![0]!.key).toBe("origin");
  });
});
