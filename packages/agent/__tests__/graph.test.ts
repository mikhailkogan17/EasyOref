/**
 * Unit tests for core agent pipeline functions.
 *
 * Tests pure/deterministic logic only — no LLM, no network.
 * Covers: buildConsensus, insertBeforeBlockEnd, buildEnrichedMessage,
 *         getClarifyNeed, textHash, toIsraelTime.
 */

import type {
  SynthesizedInsightType,
  ValidatedInsightType,
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
        channels: ["@idf_telegram", "@N12LIVE", "@kann_news"],
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
  };
});

vi.mock("@easyoref/shared/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// ── Imports (after mocks) ──────────────────────────────────

import { buildConsensus } from "../src/utils/consensus.js";
import {
  buildEnrichedMessage,
  insertBeforeBlockEnd,
} from "../src/utils/message.js";

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
    const text =
      "<blockquote>Line1\n<b>Время оповещения:</b> 18:00\n</blockquote>";
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
      value: { ru: e.value, en: e.value, he: e.value, ar: e.value },
      confidence: 0.9,
      sourceUrls: e.sourceUrls ?? [],
    }));
  }

  it("inserts origin as enrichment line", () => {
    const insights = makeInsights([{ key: "origin", value: "Иран" }]);
    const result = buildEnrichedMessage(
      baseText,
      "early_warning",
      alertTs,
      insights,
    );
    expect(result).toContain("\u{1F30D} Откуда: Иран");
  });

  it("inserts rocket count line", () => {
    const insights = makeInsights([{ key: "rocket_count", value: "~10–15" }]);
    const result = buildEnrichedMessage(
      baseText,
      "red_alert",
      alertTs,
      insights,
    );
    expect(result).toContain("\u{1F680} Ракет: ~10–15");
  });

  it("inserts rocket count with cluster munition", () => {
    const insights = makeInsights([
      { key: "rocket_count", value: "~10" },
      { key: "is_cluster_munition", value: "true" },
    ]);
    const result = buildEnrichedMessage(
      baseText,
      "red_alert",
      alertTs,
      insights,
    );
    expect(result).toContain("кассетные");
  });

  it("inserts intercepted for red_alert but NOT for early_warning", () => {
    const insights = makeInsights([{ key: "intercepted", value: "8" }]);
    const siren = buildEnrichedMessage(
      baseText,
      "red_alert",
      alertTs,
      insights,
    );
    const early = buildEnrichedMessage(
      baseText,
      "early_warning",
      alertTs,
      insights,
    );
    expect(siren).toContain("\u{1F6E1} Перехваты: 8");
    expect(early).not.toContain("Перехваты:");
  });

  it("inserts hits for red_alert but NOT for early_warning", () => {
    const insights = makeInsights([{ key: "hits", value: "Рамат-Ган" }]);
    const siren = buildEnrichedMessage(
      baseText,
      "red_alert",
      alertTs,
      insights,
    );
    const early = buildEnrichedMessage(
      baseText,
      "early_warning",
      alertTs,
      insights,
    );
    expect(siren).toContain("\u{1F4A5} Попадания: Рамат-Ган");
    expect(early).not.toContain("Попадания:");
  });

  it("inserts casualties for resolved only", () => {
    const insights = makeInsights([{ key: "casualties", value: "2 погибших" }]);
    const resolved = buildEnrichedMessage(
      baseText,
      "resolved",
      alertTs,
      insights,
    );
    const siren = buildEnrichedMessage(
      baseText,
      "red_alert",
      alertTs,
      insights,
    );
    expect(resolved).toContain("\u{1F3E5} Пострадавшие: 2 погибших");
    expect(siren).not.toContain("Пострадавшие:");
  });

  it("adds ETA as enrichment line in early_warning", () => {
    const text = "Header\nРайон: Тель-Авив";
    const insights = makeInsights([{ key: "eta_absolute", value: "~18:07" }]);
    const result = buildEnrichedMessage(
      text,
      "early_warning",
      alertTs,
      insights,
    );
    expect(result).toContain("\u23F1 Прилёт: ~18:07");
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
// buildConsensus — deterministic consensus (was voteNode)
// ─────────────────────────────────────────────────────────

describe("buildConsensus", () => {
  it("returns empty consensus for no valid insights", () => {
    const result = buildConsensus(
      [
        makeInsight(
          { kind: "rocket_count", value: { type: "exact", value: 10 } },
          { isValid: false },
        ),
      ],
      [],
    );
    expect(Object.keys(result.consensus)).toHaveLength(0);
    expect(result.needsClarify).toBe(false);
  });

  it("produces consensus for single valid insight", () => {
    const result = buildConsensus(
      [
        makeInsight({
          kind: "rocket_count",
          value: { type: "exact", value: 10 },
        }),
      ],
      [],
    );
    expect(result.consensus["rocket_count"]).toBeDefined();
    expect(result.consensus["rocket_count"]!.kind.kind).toBe("rocket_count");
  });

  it("picks highest-confidence option when values differ", () => {
    const result = buildConsensus(
      [
        makeInsight(
          { kind: "rocket_count", value: { type: "exact", value: 10 } },
          { confidence: 0.9 },
        ),
        makeInsight(
          { kind: "rocket_count", value: { type: "exact", value: 20 } },
          { confidence: 0.5 },
        ),
      ],
      [],
    );
    const consensus = result.consensus["rocket_count"]!;
    expect((consensus.kind as any).value.value).toBe(10);
    expect(consensus.rejectedInsights).toHaveLength(1);
    expect(consensus.rejectedInsights[0]?.rejectionReason).toContain(
      "not_precise",
    );
  });

  it("drops notAUserZone impact insight", () => {
    const result = buildConsensus(
      [
        makeInsight(
          {
            kind: "impact",
            value: { interceptionsCount: { type: "exact", value: 5 } },
          },
          { insightLocation: "not_a_user_zone" },
        ),
      ],
      [],
    );
    expect(result.consensus["impact"]).toBeUndefined();
  });

  it("keeps exactUserZone impact insight", () => {
    const result = buildConsensus(
      [
        makeInsight(
          {
            kind: "impact",
            value: { interceptionsCount: { type: "exact", value: 5 } },
          },
          { insightLocation: "exact_user_zone" },
        ),
      ],
      [],
    );
    expect(result.consensus["impact"]).toBeDefined();
    expect(result.consensus["impact"]!.insightLocation).toBe("exact_user_zone");
  });

  it("exactUserZone wins over userMacroRegion in merging", () => {
    const result = buildConsensus(
      [
        makeInsight(
          {
            kind: "impact",
            value: { interceptionsCount: { type: "exact", value: 5 } },
          },
          { insightLocation: "user_macro_region", confidence: 0.9 },
        ),
        makeInsight(
          {
            kind: "impact",
            value: { interceptionsCount: { type: "exact", value: 5 } },
          },
          { insightLocation: "exact_user_zone", confidence: 0.8 },
        ),
      ],
      [],
    );
    const consensus = result.consensus["impact"]!;
    expect(consensus.insightLocation).toBe("exact_user_zone");
  });

  it("always returns needsClarify=false (clarify removed)", () => {
    const result = buildConsensus(
      [
        makeInsight(
          { kind: "eta", value: { kind: "minutes", minutes: 5 } },
          { confidence: 0.3 },
        ),
      ],
      [],
    );
    expect(result.needsClarify).toBe(false);
  });

  it("carries forward previousInsights into consensus", () => {
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
    const result = buildConsensus([], [prev]);
    expect(result.consensus["country_origins"]).toBeDefined();
    expect(result.consensus["country_origins"]!.reason).toContain(
      "carry_forward_refresh",
    );
  });

  it("does not weight Hebrew channels differently from Russian channels", () => {
    const hebrewInsight = makeInsight(
      { kind: "country_origins", value: ["Iran"] },
      {
        confidence: 0.85,
        sourceTrust: 0.8,
        source: makeSource("@kann_news"),
      },
    );
    const russianInsight = makeInsight(
      { kind: "country_origins", value: ["Iran"] },
      {
        confidence: 0.85,
        sourceTrust: 0.8,
        source: makeSource("@rian_ru"),
      },
    );

    const heResult = buildConsensus([hebrewInsight], []);
    const heCons = heResult.consensus["country_origins"]!;

    const ruResult = buildConsensus([russianInsight], []);
    const ruCons = ruResult.consensus["country_origins"]!;

    expect(heCons.confidence).toBe(ruCons.confidence);
    expect(heCons.sourceTrust).toBe(ruCons.sourceTrust);
    expect(heCons.timeRelevance).toBe(ruCons.timeRelevance);
    expect(heCons.regionRelevance).toBe(ruCons.regionRelevance);

    const mixedResult = buildConsensus([hebrewInsight, russianInsight], []);
    const mixedCons = mixedResult.consensus["country_origins"]!;

    expect(mixedCons.confidence).toBe(0.85);
    expect(mixedCons.sourceTrust).toBe(0.8);
    expect(mixedCons.sources).toHaveLength(2);
    const channelIds = mixedCons.sources.map((s) => s.channelId);
    expect(channelIds).toContain("@kann_news");
    expect(channelIds).toContain("@rian_ru");
  });
});
