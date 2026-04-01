/**
 * Unit tests for core agent pipeline functions.
 *
 * Tests pure/deterministic logic only — no LLM, no network.
 * Covers: voteNode, insertBeforeBlockEnd, buildEnrichedMessage,
 *         describeContradictions, getClarifyNeed, textHash, toIsraelTime.
 */

import type {
  SynthesizedInsightType,
  ValidatedInsightType,
  VotedResultType,
} from "@easyoref/shared";
import { getClarifyNeed, textHash, toIsraelTime } from "@easyoref/shared";
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
        channels: ["@idf_telegram", "@N12LIVE", "@kann_news"],
        areaLabels: {},
      },
      botToken: "",
      areas: ["תל אביב - דרום העיר ויפו"],
      language: "ru",
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
  };
});

vi.mock("@easyoref/monitoring", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// ── Imports (after mocks) ──────────────────────────────────

import {
  buildEnrichedMessage,
  insertBeforeBlockEnd,
} from "../src/utils/message.js";
import { describeContradictions } from "../src/utils/contradictions.js";
import { voteNode } from "../src/nodes/vote-node.js";

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function makeSource(channelId = "@test", ts = Date.now()) {
  return {
    channelId,
    sourceType: "telegram_channel" as const,
    timestamp: ts,
    text: "test post text",
  };
}

function makeInsight(
  kind: ValidatedInsightType["kind"],
  overrides: Partial<ValidatedInsightType> = {},
): ValidatedInsightType {
  return {
    kind,
    timeRelevance: 0.9,
    regionRelevance: 0.9,
    confidence: 0.8,
    source: makeSource(),
    timeStamp: new Date().toISOString(),
    isValid: true,
    sourceTrust: 0.8,
    ...overrides,
  };
}

function makeState(
  filteredInsights: ValidatedInsightType[] = [],
  previousInsights: VotedResultType["consensus"][string][] = [],
) {
  return {
    messages: [],
    filteredInsights,
    previousInsights,
    extractedInsights: [],
    votedResult: undefined,
    synthesizedInsights: [],
    channelTracking: {
      trackStartTimestamp: Date.now(),
      lastUpdateTimestamp: Date.now(),
      channelsWithUpdates: [],
    },
    alertId: "test-alert",
    alertType: "early_warning" as const,
    alertTs: Date.now(),
    alertAreas: [],
  };
}

// ─────────────────────────────────────────────────────────
// textHash
// ─────────────────────────────────────────────────────────

describe("textHash", () => {
  it("returns stable hash for same input", () => {
    expect(textHash("hello")).toBe(textHash("hello"));
    expect(textHash("hello")).toMatch(/^[a-f0-9]+$/);
  });

  it("returns different hash for different input", () => {
    expect(textHash("a")).not.toBe(textHash("b"));
  });
});

// ─────────────────────────────────────────────────────────
// toIsraelTime
// ─────────────────────────────────────────────────────────

describe("toIsraelTime", () => {
  it("formats UTC timestamp to HH:MM in Israel timezone", () => {
    // 2024-01-15 12:00 UTC = 14:00 IST (UTC+2 winter)
    const ts = new Date("2024-01-15T12:00:00Z").getTime();
    expect(toIsraelTime(ts)).toMatch(/14:00/);
  });

  it("returns HH:MM format", () => {
    expect(toIsraelTime(Date.now())).toMatch(/^\d{2}:\d{2}$/);
  });
});

// ─────────────────────────────────────────────────────────
// getClarifyNeed
// ─────────────────────────────────────────────────────────

describe("getClarifyNeed", () => {
  it("returns needs_clarify for low confidence eta", () => {
    expect(getClarifyNeed("eta", 0.3)).toBe("needs_clarify");
  });

  it("returns verified for high confidence country_origins", () => {
    expect(getClarifyNeed("country_origins", 0.9)).toBe("verified");
  });

  it("returns uncertain for mid confidence rocket_count", () => {
    expect(getClarifyNeed("rocket_count", 0.45)).toBe("uncertain");
  });

  it("returns uncertain for unknown kind", () => {
    expect(getClarifyNeed("unknown_kind", 0.5)).toBe("uncertain");
  });
});

// ─────────────────────────────────────────────────────────
// insertBeforeBlockEnd
// ─────────────────────────────────────────────────────────

describe("insertBeforeBlockEnd", () => {
  it("inserts before </blockquote> tag", () => {
    const text = "<blockquote>Line1\n<b>Время оповещения:</b> 18:00\n</blockquote>";
    const result = insertBeforeBlockEnd(text, "NEW LINE");
    expect(result.indexOf("NEW LINE")).toBeLessThan(
      result.indexOf("</blockquote>"),
    );
    expect(result).toContain("NEW LINE\n</blockquote>");
  });

  it("falls back to before Время оповещения line when no blockquote", () => {
    const text = "Header\n<b>Время оповещения:</b> 18:00";
    const result = insertBeforeBlockEnd(text, "NEW LINE");
    expect(result.indexOf("NEW LINE")).toBeLessThan(
      result.indexOf("Время оповещения:"),
    );
  });

  it("falls back to before last line when no time pattern or blockquote", () => {
    const text = "Line1\nLine2\nLine3";
    const result = insertBeforeBlockEnd(text, "NEW");
    const lines = result.split("\n");
    expect(lines[lines.length - 2]).toBe("NEW");
    expect(lines[lines.length - 1]).toBe("Line3");
  });
});

// ─────────────────────────────────────────────────────────
// buildEnrichedMessage
// ─────────────────────────────────────────────────────────

describe("buildEnrichedMessage", () => {
  const alertTs = new Date("2024-03-09T16:00:00Z").getTime();
  const baseText = "Header\n<b>Время оповещения:</b> 18:00";

  function makeInsights(
    entries: Array<{ key: string; value: string; sourceUrls?: string[] }>,
  ): SynthesizedInsightType[] {
    return entries.map((e) => ({
      key: e.key,
      value: e.value,
      confidence: 0.9,
      sourceUrls: e.sourceUrls ?? [],
    }));
  }

  it("inserts origin as enrichment line", () => {
    const insights = makeInsights([{ key: "origin", value: "Иран" }]);
    const result = buildEnrichedMessage(baseText, "early_warning", alertTs, insights);
    expect(result).toContain("<b>Откуда:</b> Иран");
  });

  it("inserts rocket count line", () => {
    const insights = makeInsights([{ key: "rocket_count", value: "~10–15" }]);
    const result = buildEnrichedMessage(baseText, "red_alert", alertTs, insights);
    expect(result).toContain("<b>Ракет:</b> ~10–15");
  });

  it("inserts rocket count with cassette", () => {
    const insights = makeInsights([
      { key: "rocket_count", value: "~10" },
      { key: "is_cassette", value: "true" },
    ]);
    const result = buildEnrichedMessage(baseText, "red_alert", alertTs, insights);
    expect(result).toContain("кассетные");
  });

  it("inserts intercepted for red_alert but NOT for early_warning", () => {
    const insights = makeInsights([{ key: "intercepted", value: "8" }]);
    const siren = buildEnrichedMessage(baseText, "red_alert", alertTs, insights);
    const early = buildEnrichedMessage(baseText, "early_warning", alertTs, insights);
    expect(siren).toContain("<b>Перехваты:</b> 8");
    expect(early).not.toContain("Перехваты:");
  });

  it("inserts hits for red_alert but NOT for early_warning", () => {
    const insights = makeInsights([{ key: "hits", value: "Рамат-Ган" }]);
    const siren = buildEnrichedMessage(baseText, "red_alert", alertTs, insights);
    const early = buildEnrichedMessage(baseText, "early_warning", alertTs, insights);
    expect(siren).toContain("<b>Попадания:</b> Рамат-Ган");
    expect(early).not.toContain("Попадания:");
  });

  it("inserts casualties for resolved only", () => {
    const insights = makeInsights([{ key: "casualties", value: "2 погибших" }]);
    const resolved = buildEnrichedMessage(baseText, "resolved", alertTs, insights);
    const siren = buildEnrichedMessage(baseText, "red_alert", alertTs, insights);
    expect(resolved).toContain("<b>Погибшие:</b> 2 погибших");
    expect(siren).not.toContain("Погибшие:");
  });

  it("adds ETA as enrichment line in early_warning", () => {
    const text = "Header\nРайон: Тель-Авив";
    const insights = makeInsights([{ key: "eta_absolute", value: "~18:07" }]);
    const result = buildEnrichedMessage(text, "early_warning", alertTs, insights);
    expect(result).toContain("<b>Прилёт:</b> ~18:07");
  });

  it("does NOT add ETA in resolved phase", () => {
    const text = "Header\nРайон: Тель-Авив";
    const insights = makeInsights([{ key: "eta_absolute", value: "~18:07" }]);
    const result = buildEnrichedMessage(text, "resolved", alertTs, insights);
    // ETA skipped for resolved
    expect(result).not.toContain("Прилёт:");
  });
});

// ─────────────────────────────────────────────────────────
// describeContradictions
// ─────────────────────────────────────────────────────────

describe("describeContradictions", () => {
  it("reports multiple country origins", () => {
    const insights: ValidatedInsightType[] = [
      makeInsight({
        kind: "country_origins",
        value: ["Iran"],
      }),
      makeInsight({
        kind: "country_origins",
        value: ["Yemen"],
      }),
    ];
    const result = describeContradictions(insights);
    expect(result).toMatch(/Iran/);
    expect(result).toMatch(/Yemen/);
  });

  it("reports wide rocket count range", () => {
    const insights: ValidatedInsightType[] = [
      makeInsight({ kind: "rocket_count", value: { type: "exact", value: 5 } }),
      makeInsight({ kind: "rocket_count", value: { type: "exact", value: 15 } }),
    ];
    const result = describeContradictions(insights);
    expect(result).toMatch(/5.{1,5}15/);
  });

  it("reports low confidence insights", () => {
    const insights: ValidatedInsightType[] = [
      makeInsight(
        { kind: "eta", value: { kind: "minutes", minutes: 5 } },
        { confidence: 0.3 },
      ),
    ];
    const result = describeContradictions(insights);
    expect(result).toContain("low confidence");
  });

  it("always includes total valid insights count", () => {
    const insights: ValidatedInsightType[] = [
      makeInsight({ kind: "rocket_count", value: { type: "exact", value: 10 } }),
    ];
    const result = describeContradictions(insights);
    expect(result).toContain("Total valid insights: 1");
  });

  it("returns empty issues for single clean insight", () => {
    const insights: ValidatedInsightType[] = [
      makeInsight(
        { kind: "rocket_count", value: { type: "exact", value: 10 } },
        { confidence: 0.9 },
      ),
    ];
    const result = describeContradictions(insights);
    // Should still have kind/count lines
    expect(result).toContain("rocket_count");
  });
});

// ─────────────────────────────────────────────────────────
// voteNode — deterministic consensus
// ─────────────────────────────────────────────────────────

describe("voteNode", () => {
  it("returns empty consensus for no valid insights", async () => {
    const state = makeState([
      makeInsight(
        { kind: "rocket_count", value: { type: "exact", value: 10 } },
        { isValid: false },
      ),
    ]);
    const result = await voteNode(state as any);
    expect(result.votedResult).toBeDefined();
    expect(Object.keys(result.votedResult!.consensus)).toHaveLength(0);
    expect(result.votedResult!.needsClarify).toBe(false);
  });

  it("produces consensus for single valid insight", async () => {
    const state = makeState([
      makeInsight({ kind: "rocket_count", value: { type: "exact", value: 10 } }),
    ]);
    const result = await voteNode(state as any);
    expect(result.votedResult!.consensus["rocket_count"]).toBeDefined();
    expect(result.votedResult!.consensus["rocket_count"]!.kind.kind).toBe("rocket_count");
  });

  it("picks highest-confidence option when values differ", async () => {
    const state = makeState([
      makeInsight(
        { kind: "rocket_count", value: { type: "exact", value: 10 } },
        { confidence: 0.9 },
      ),
      makeInsight(
        { kind: "rocket_count", value: { type: "exact", value: 20 } },
        { confidence: 0.5 },
      ),
    ]);
    const result = await voteNode(state as any);
    const consensus = result.votedResult!.consensus["rocket_count"]!;
    expect((consensus.kind as any).value.value).toBe(10);
  });

  it("drops notAUserZone impact insight", async () => {
    const state = makeState([
      makeInsight(
        { kind: "impact", value: { interceptionsCount: { type: "exact", value: 5 } } },
        { insightLocation: "not_a_user_zone" },
      ),
    ]);
    const result = await voteNode(state as any);
    expect(result.votedResult!.consensus["impact"]).toBeUndefined();
  });

  it("keeps exactUserZone impact insight", async () => {
    const state = makeState([
      makeInsight(
        { kind: "impact", value: { interceptionsCount: { type: "exact", value: 5 } } },
        { insightLocation: "exact_user_zone" },
      ),
    ]);
    const result = await voteNode(state as any);
    expect(result.votedResult!.consensus["impact"]).toBeDefined();
    expect(result.votedResult!.consensus["impact"]!.insightLocation).toBe("exact_user_zone");
  });

  it("exactUserZone wins over userMacroRegion in merging", async () => {
    const state = makeState([
      makeInsight(
        { kind: "impact", value: { interceptionsCount: { type: "exact", value: 5 } } },
        { insightLocation: "user_macro_region", confidence: 0.9 },
      ),
      makeInsight(
        { kind: "impact", value: { interceptionsCount: { type: "exact", value: 5 } } },
        { insightLocation: "exact_user_zone", confidence: 0.8 },
      ),
    ]);
    const result = await voteNode(state as any);
    // Both have same value — same option → insightLocation merges: exact wins
    const consensus = result.votedResult!.consensus["impact"]!;
    expect(consensus.insightLocation).toBe("exact_user_zone");
  });

  it("sets needsClarify=true when low-confidence eta insight", async () => {
    const state = makeState([
      makeInsight(
        { kind: "eta", value: { kind: "minutes", minutes: 5 } },
        { confidence: 0.3 }, // below needsClarify threshold for eta (0.4)
      ),
    ]);
    const result = await voteNode(state as any);
    expect(result.votedResult!.needsClarify).toBe(true);
  });

  it("carries forward previousInsights into consensus", async () => {
    const prev = {
      kind: { kind: "country_origins" as const, value: ["Iran"] },
      sources: [makeSource("@prev")],
      confidence: 0.85,
      sourceTrust: 0.9,
      timeRelevance: 0.8,
      regionRelevance: 0.9,
      reason: "carry-forward",
      rejectedInsights: [],
      insightLocation: undefined,
    };
    const state = makeState([], [prev]);
    const result = await voteNode(state as any);
    expect(result.votedResult!.consensus["country_origins"]).toBeDefined();
  });

  it("does not weight Hebrew channels differently from Russian channels", async () => {
    // Hebrew and Russian channels report the same insight with equal confidence.
    // The vote node must treat them identically — no language-based weighting.
    const hebrewInsight = makeInsight(
      { kind: "country_origins", value: ["Iran"] },
      {
        confidence: 0.85,
        sourceTrust: 0.8,
        source: makeSource("@kann_news"),  // Hebrew channel
      },
    );
    const russianInsight = makeInsight(
      { kind: "country_origins", value: ["Iran"] },
      {
        confidence: 0.85,
        sourceTrust: 0.8,
        source: makeSource("@rian_ru"),  // Russian channel
      },
    );

    // Run with only Hebrew source
    const heOnly = makeState([hebrewInsight]);
    const heResult = await voteNode(heOnly as any);
    const heCons = heResult.votedResult!.consensus["country_origins"]!;

    // Run with only Russian source
    const ruOnly = makeState([russianInsight]);
    const ruResult = await voteNode(ruOnly as any);
    const ruCons = ruResult.votedResult!.consensus["country_origins"]!;

    // Confidence, sourceTrust, time/region relevance must be identical
    expect(heCons.confidence).toBe(ruCons.confidence);
    expect(heCons.sourceTrust).toBe(ruCons.sourceTrust);
    expect(heCons.timeRelevance).toBe(ruCons.timeRelevance);
    expect(heCons.regionRelevance).toBe(ruCons.regionRelevance);

    // Run with mixed Hebrew + Russian — both contribute equally
    const mixed = makeState([hebrewInsight, russianInsight]);
    const mixedResult = await voteNode(mixed as any);
    const mixedCons = mixedResult.votedResult!.consensus["country_origins"]!;

    // Mixed consensus should average both (equal weight → same values)
    expect(mixedCons.confidence).toBe(0.85);
    expect(mixedCons.sourceTrust).toBe(0.8);
    expect(mixedCons.sources).toHaveLength(2);
    // Both channels present as sources
    const channelIds = mixedCons.sources.map((s) => s.channelId);
    expect(channelIds).toContain("@kann_news");
    expect(channelIds).toContain("@rian_ru");
  });
});
