/**
 * Tests for enrichment pipeline functions.
 *
 * Split into two parts:
 *   1. Unit tests — no LLM, no network. Test pure functions from extract, vote, message, helpers.
 *   2. Integration tests — call real OpenRouter API (skipped without OPENROUTER_API_KEY env).
 *
 * Run with integration: OPENROUTER_API_KEY=sk-or-... npm test
 */

import {
  emptyEnrichmentData,
  type CitedSource,
  type InlineCite,
  type ValidatedExtraction,
  type VotedResult,
} from "@easyoref/shared";
import { describe, expect, it, vi } from "vitest";

// ── Mocks — minimal, only for config & logger ─────────

vi.mock("@easyoref/shared", async () => {
  const actual = await vi.importActual("@easyoref/shared");
  return {
    ...actual,
    config: {
      agent: {
        filterModel: "google/gemini-2.5-flash-lite",
        extractModel: "google/gemini-3.1-flash-lite-preview",
        apiKey: process.env.OPENROUTER_API_KEY ?? "test-key",
        mcpTools: false,
        clarifyFetchCount: 3,
        confidenceThreshold: 0.6,
        channels: ["@idf_telegram", "@N12LIVE", "@kann_news"],
        areaLabels: { הרצליה: "Герцлия" },
      },
      botToken: "",
      areas: ["הרצליה", "תל אביב - דרום העיר ויפו"],
      language: "ru",
      orefApiUrl: "https://mock.oref.api/alerts",
      orefHistoryUrl: "",
      logtailToken: "",
    },
    getRedis: vi.fn().mockReturnValue({
      lpush: vi.fn(),
      expire: vi.fn(),
    }),
    pushSessionPost: vi.fn(),
    pushChannelPost: vi.fn(),
    getActiveSession: vi.fn().mockResolvedValue(null),
    getChannelPosts: vi.fn().mockResolvedValue([]),
    getEnrichmentData: vi.fn().mockResolvedValue(null),
    saveEnrichmentData: vi.fn(),
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

// ── Imports (after mocks are hoisted) ──────────────────

import { textHash, toIsraelTime } from "@easyoref/shared";
import { postFilter } from "../src/nodes/extract-node.js";
import {
  buildEnrichedMessage,
  buildEnrichmentFromVote,
  buildGlobalCiteMap,
  CERTAIN,
  COUNTRY_RU,
  extractCites,
  inlineCites,
  inlineCitesFromData,
  insertBeforeTimeLine,
  renderCitesGlobal,
  SKIP,
  UNCERTAIN,
} from "../src/nodes/message.js";
import { vote } from "../src/nodes/vote-node.js";

// ═══════════════════════════════════════════════════════
// PART 1: UNIT TESTS (pure functions, no LLM)
// ═══════════════════════════════════════════════════════

// ─── textHash ──────────────────────────────────────────

describe("textHash", () => {
  it("returns stable hash for same input", () => {
    const h1 = textHash("hello world");
    const h2 = textHash("hello world");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{16,32}$/);
  });

  it("returns different hash for different input", () => {
    expect(textHash("a")).not.toBe(textHash("b"));
  });
});

// ─── toIsraelTime ──────────────────────────────────────

describe("toIsraelTime", () => {
  it("formats timestamp in Israel timezone", () => {
    const ts = new Date("2024-01-15T12:00:00Z").getTime();
    const result = toIsraelTime(ts);
    expect(result).toMatch(/14:00/);
  });
});

// ─── postFilter ────────────────────────────────────────

describe("postFilter", () => {
  function makeExtraction(
    overrides: Partial<ValidatedExtraction> = {},
  ): ValidatedExtraction {
    return {
      channel: "@test",
      regionRelevance: 0.9,
      sourceTrust: 0.8,
      tone: "calm" as const,
      timeRelevance: 0.9,
      countryOrigin: "Iran",
      rocketCount: 10,
      isCassette: undefined,
      intercepted: undefined,
      interceptedQual: undefined,
      seaImpact: undefined,
      seaImpactQual: undefined,
      openAreaImpact: undefined,
      openAreaImpactQual: undefined,
      hitsConfirmed: undefined,
      casualties: undefined,
      injuries: undefined,
      etaRefinedMinutes: undefined,
      rocketDetail: undefined,
      confidence: 0.7,
      valid: true,
      ...overrides,
    };
  }

  it("passes valid extraction", () => {
    const result = postFilter([makeExtraction()], "test-1");
    expect(result[0].valid).toBe(true);
  });

  it("rejects stale posts (timeRelevance < 0.5)", () => {
    const result = postFilter(
      [makeExtraction({ timeRelevance: 0.3 })],
      "test-1",
    );
    expect(result[0].valid).toBe(false);
    expect(result[0].rejectReason).toBe("stale_post");
  });

  it("rejects region_irrelevant posts", () => {
    const result = postFilter(
      [makeExtraction({ regionRelevance: 0.2 })],
      "test-1",
    );
    expect(result[0].valid).toBe(false);
    expect(result[0].rejectReason).toBe("region_irrelevant");
  });

  it("rejects untrusted sources", () => {
    const result = postFilter([makeExtraction({ sourceTrust: 0.2 })], "test-1");
    expect(result[0].valid).toBe(false);
    expect(result[0].rejectReason).toBe("untrusted_source");
  });

  it("rejects alarmist tone", () => {
    const result = postFilter([makeExtraction({ tone: "alarmist" })], "test-1");
    expect(result[0].valid).toBe(false);
    expect(result[0].rejectReason).toBe("alarmist_tone");
  });

  it("rejects extraction with no data fields", () => {
    const result = postFilter(
      [
        makeExtraction({
          countryOrigin: undefined,
          rocketCount: undefined,
          isCassette: undefined,
          intercepted: undefined,
          interceptedQual: undefined,
          hitsConfirmed: undefined,
          casualties: undefined,
          injuries: undefined,
          etaRefinedMinutes: undefined,
        }),
      ],
      "test-1",
    );
    expect(result[0].valid).toBe(false);
    expect(result[0].rejectReason).toBe("no_data");
  });

  it("rejects low confidence", () => {
    const result = postFilter([makeExtraction({ confidence: 0.1 })], "test-1");
    expect(result[0].valid).toBe(false);
    expect(result[0].rejectReason).toBe("low_confidence");
  });

  it("timeRelevance is checked FIRST (before region)", () => {
    const result = postFilter(
      [makeExtraction({ timeRelevance: 0.1, regionRelevance: 0.1 })],
      "test-1",
    );
    expect(result[0].rejectReason).toBe("stale_post");
  });
});

// ─── vote ──────────────────────────────────────────────

describe("vote", () => {
  function makeValidExtraction(
    overrides: Partial<ValidatedExtraction> = {},
  ): ValidatedExtraction {
    return {
      channel: "@test",
      regionRelevance: 0.9,
      sourceTrust: 0.8,
      tone: "calm" as const,
      timeRelevance: 0.9,
      countryOrigin: "Iran",
      rocketCount: 10,
      isCassette: undefined,
      intercepted: undefined,
      interceptedQual: undefined,
      seaImpact: undefined,
      seaImpactQual: undefined,
      openAreaImpact: undefined,
      openAreaImpactQual: undefined,
      hitsConfirmed: undefined,
      casualties: undefined,
      injuries: undefined,
      etaRefinedMinutes: undefined,
      rocketDetail: undefined,
      confidence: 0.8,
      valid: true,
      messageUrl: "https://t.me/test/1",
      ...overrides,
    };
  }

  it("returns undefined for empty valid extractions", () => {
    const result = vote([makeValidExtraction({ valid: false })], "test-1");
    expect(result).toBeUndefined();
  });

  it("aggregates country origins from multiple sources", () => {
    const result = vote(
      [
        makeValidExtraction({
          channel: "@a",
          countryOrigin: "Iran",
          messageUrl: "https://t.me/a/1",
        }),
        makeValidExtraction({
          channel: "@b",
          countryOrigin: "Iran",
          messageUrl: "https://t.me/b/1",
        }),
      ],
      "test-1",
    );
    expect(result).not.toBeNull();
    expect(result!.countryOrigins).toHaveLength(1);
    expect(result!.countryOrigins![0].name).toBe("Iran");
    expect(result!.countryOrigins![0].citations).toHaveLength(2);
  });

  it("computes rocket count range", () => {
    const result = vote(
      [
        makeValidExtraction({ rocketCount: 10 }),
        makeValidExtraction({ rocketCount: 15 }),
      ],
      "test-1",
    );
    expect(result!.rocketCountMin).toBe(10);
    expect(result!.rocketCountMax).toBe(15);
    expect(result!.rocketCitations).toHaveLength(2);
  });

  it("median injuries from multiple sources", () => {
    const result = vote(
      [
        makeValidExtraction({ injuries: 5 }),
        makeValidExtraction({ injuries: 3 }),
        makeValidExtraction({ injuries: 8 }),
      ],
      "test-1",
    );
    expect(result!.injuries).toBe(5);
    expect(result!.injuriesCitations).toHaveLength(3);
  });

  it("sets citedSources with 1-based indices", () => {
    const result = vote(
      [
        makeValidExtraction({
          channel: "@a",
          messageUrl: "https://t.me/a/1",
        }),
        makeValidExtraction({
          channel: "@b",
          messageUrl: "https://t.me/b/1",
        }),
      ],
      "test-1",
    );
    expect(result!.citedSources).toHaveLength(2);
    expect(result!.citedSources[0].index).toBe(1);
    expect(result!.citedSources[1].index).toBe(2);
  });
});

// ─── inlineCites ───────────────────────────────────────

describe("inlineCites", () => {
  const sources: CitedSource[] = [
    { index: 1, channel: "@a", messageUrl: "https://t.me/a/1" },
    { index: 2, channel: "@b", messageUrl: "https://t.me/b/2" },
    { index: 3, channel: "@c", messageUrl: undefined },
  ];

  it("returns HTML links for indices with URLs", () => {
    const result = inlineCites([1, 2], sources);
    expect(result).toContain('<a href="https://t.me/a/1">[1]</a>');
    expect(result).toContain('<a href="https://t.me/b/2">[2]</a>');
  });

  it("skips indices without URLs", () => {
    const result = inlineCites([3], sources);
    expect(result).toBe("");
  });

  it("returns empty string for no indices", () => {
    const result = inlineCites([], sources);
    expect(result).toBe("");
  });
});

// ─── inlineCitesFromData ───────────────────────────────

describe("inlineCitesFromData", () => {
  it("renders InlineCite array to HTML", () => {
    const cites: InlineCite[] = [
      { url: "https://t.me/a/1", channel: "@a" },
      { url: "https://t.me/b/2", channel: "@b" },
    ];
    const result = inlineCitesFromData(cites);
    expect(result).toContain('<a href="https://t.me/a/1">[1]</a>');
    expect(result).toContain('<a href="https://t.me/b/2">[2]</a>');
  });

  it("returns empty for empty array", () => {
    expect(inlineCitesFromData([])).toBe("");
  });
});

// ─── buildGlobalCiteMap + renderCitesGlobal ────────────

describe("buildGlobalCiteMap", () => {
  it("assigns unique sequential indices by URL", () => {
    const data = { ...emptyEnrichmentData };
    data.originCites = [{ url: "https://t.me/a/1", channel: "@a" }];
    data.rocketCites = [
      { url: "https://t.me/a/1", channel: "@a" },
      { url: "https://t.me/b/2", channel: "@b" },
    ];
    const map = buildGlobalCiteMap(data);
    expect(map.get("https://t.me/a/1")).toBe(1);
    expect(map.get("https://t.me/b/2")).toBe(2);
    expect(map.size).toBe(2);
  });

  it("returns empty map for empty enrichment", () => {
    const map = buildGlobalCiteMap(emptyEnrichmentData);
    expect(map.size).toBe(0);
  });
});

describe("renderCitesGlobal", () => {
  it("renders citations with global indices", () => {
    const globalMap = new Map([
      ["https://t.me/a/1", 1],
      ["https://t.me/b/2", 3],
    ]);
    const cites: InlineCite[] = [{ url: "https://t.me/b/2", channel: "@b" }];
    const result = renderCitesGlobal(cites, globalMap);
    expect(result).toBe(' <a href="https://t.me/b/2">[3]</a>');
  });

  it("returns empty for empty cites", () => {
    const map = new Map([["https://t.me/a/1", 1]]);
    expect(renderCitesGlobal([], map)).toBe("");
  });
});

// ─── extractCites ──────────────────────────────────────

describe("extractCites", () => {
  const sources: CitedSource[] = [
    { index: 1, channel: "@a", messageUrl: "https://t.me/a/1" },
    { index: 2, channel: "@b" },
  ];

  it("returns InlineCite objects with url and channel", () => {
    const cites = extractCites([1], sources);
    expect(cites).toHaveLength(1);
    expect(cites[0].url).toBe("https://t.me/a/1");
    expect(cites[0].channel).toBe("@a");
  });

  it("skips sources without messageUrl", () => {
    const cites = extractCites([2], sources);
    expect(cites).toHaveLength(0);
  });
});

// ─── buildEnrichmentFromVote ───────────────────────────

describe("buildEnrichmentFromVote", () => {
  const alertTs = new Date("2024-03-09T16:00:00Z").getTime();

  function makeVoted(overrides: Partial<VotedResult> = {}): VotedResult {
    return {
      etaRefinedMinutes: undefined,
      etaCitations: [],
      countryOrigins: [{ name: "Iran", citations: [1] }],
      rocketCountMin: 10,
      rocketCountMax: 15,
      rocketCitations: [1, 2],
      rocketConfidence: 0.8,
      isCassette: undefined,
      isCassetteConfidence: 0,
      intercepted: 8,
      interceptedQual: undefined,
      interceptedConfidence: 0.7,
      seaImpact: undefined,
      seaImpactQual: undefined,
      seaConfidence: 0,
      openAreaImpact: undefined,
      openAreaImpactQual: undefined,
      openAreaConfidence: 0,
      hitsConfirmed: 1,
      hitsCitations: [2],
      hitsConfidence: 0.7,
      noImpacts: false,
      noImpactsCitations: [],
      interceptedCitations: [1],
      rocketDetail: undefined,
      casualties: undefined,
      casualtiesCitations: [],
      casualtiesConfidence: 0,
      injuries: 3,
      injuriesCitations: [1],
      injuriesConfidence: 0.7,
      confidence: 0.75,
      sourcesCount: 2,
      citedSources: [
        { index: 1, channel: "@a", messageUrl: "https://t.me/a/1" },
        { index: 2, channel: "@b", messageUrl: "https://t.me/b/2" },
      ],
      ...overrides,
    };
  }

  it("sets origin from voted countryOrigins", () => {
    const data = buildEnrichmentFromVote(
      makeVoted(),
      emptyEnrichmentData,
      "early_warning",
      alertTs,
    );
    expect(data.origin).toBe("Иран");
    expect(data.originCites).toHaveLength(1);
    expect(data.originCites[0].url).toBe("https://t.me/a/1");
  });

  it("preserves carry-forward data from prev", () => {
    const prev = emptyEnrichmentData;
    prev.origin = "Йемен";
    prev.originCites = [{ url: "https://t.me/old/1", channel: "@old" }];

    const voted = makeVoted({ countryOrigins: undefined });
    const data = buildEnrichmentFromVote(voted, prev, "red_alert", alertTs);
    expect(data.origin).toBe("Йемен");
    expect(data.originCites).toHaveLength(1);
  });

  it("sets ETA for early_warning", () => {
    const voted = makeVoted({ etaRefinedMinutes: 5 });
    const data = buildEnrichmentFromVote(
      voted,
      emptyEnrichmentData,
      "early_warning",
      alertTs,
    );
    expect(data.etaAbsolute).toMatch(/^~\d{2}:\d{2}$/);
  });

  it("sets injuries for resolved phase", () => {
    const voted = makeVoted({ injuries: 3, injuriesConfidence: 0.95 });
    const data = buildEnrichmentFromVote(
      voted,
      emptyEnrichmentData,
      "resolved",
      alertTs,
    );
    expect(data.injuries).toBe("3");
    expect(data.injuriesCites).toHaveLength(1);
  });

  it("shows uncertainty marker for injuries at sub-certain confidence", () => {
    const voted = makeVoted({ injuries: 3, injuriesConfidence: 0.8 });
    const data = buildEnrichmentFromVote(
      voted,
      emptyEnrichmentData,
      "resolved",
      alertTs,
    );
    expect(data.injuries).toBe("3 (?)");
  });

  it("records earlyWarningTime on first early_warning", () => {
    const data = buildEnrichmentFromVote(
      makeVoted(),
      emptyEnrichmentData,
      "early_warning",
      alertTs,
    );
    expect(data.earlyWarningTime).toBeTruthy();
    expect(data.earlyWarningTime).toMatch(/\d{2}:\d{2}/);
  });
});

// ─── buildEnrichedMessage ──────────────────────────────

describe("buildEnrichedMessage", () => {
  const alertTs = new Date("2024-03-09T16:00:00Z").getTime();

  it("inserts origin before time line", () => {
    const enrichment = emptyEnrichmentData;
    enrichment.origin = "Иран";
    enrichment.originCites = [{ url: "https://t.me/a/1", channel: "@a" }];

    const text =
      "🔴 Тревога!\nОбласть: Герцлия\n<b>Время оповещения:</b> 18:00";
    const result = buildEnrichedMessage(
      text,
      "early_warning",
      alertTs,
      enrichment,
    );
    expect(result).toContain("<b>Откуда:</b> Иран");
    expect(result).toContain('<a href="https://t.me/a/1">[1]</a>');
    const originIdx = result.indexOf("Откуда:");
    const timeIdx = result.indexOf("Время оповещения:");
    expect(originIdx).toBeLessThan(timeIdx);
  });

  it("inserts rocket count and intercepted as separate lines", () => {
    const enrichment = emptyEnrichmentData;
    enrichment.rocketCount = "~10–15";
    enrichment.intercepted = "8";
    enrichment.rocketCites = [{ url: "https://t.me/a/1", channel: "@a" }];
    enrichment.interceptedCites = [{ url: "https://t.me/b/1", channel: "@b" }];

    const text = "🔴 Тревога!\n<b>Время оповещения:</b> 18:00";
    const result = buildEnrichedMessage(text, "red_alert", alertTs, enrichment);
    expect(result).toContain("<b>Ракет:</b> ~10–15");
    expect(result).toContain("<b>Перехваты:</b> 8");
    expect(result).not.toContain("из них");
  });

  it("inserts casualties/injuries only for resolved", () => {
    const enrichment = emptyEnrichmentData;
    enrichment.casualties = "2";
    enrichment.injuries = "5";
    enrichment.casualtiesCites = [{ url: "https://t.me/a/1", channel: "@a" }];
    enrichment.injuriesCites = [{ url: "https://t.me/b/1", channel: "@b" }];

    const text = "✅ Отбой\n<b>Время оповещения:</b> 18:00";
    const resultResolved = buildEnrichedMessage(
      text,
      "resolved",
      alertTs,
      enrichment,
    );
    expect(resultResolved).toContain("<b>Погибшие:</b> 2");
    expect(resultResolved).toContain("<b>Пострадавшие:</b> 5");

    const resultSiren = buildEnrichedMessage(
      text,
      "red_alert",
      alertTs,
      enrichment,
    );
    expect(resultSiren).not.toContain("Погибшие:");
    expect(resultSiren).not.toContain("Пострадавшие:");
  });

  it("does not insert early warning time in siren phase (replaced by reply chain)", () => {
    const enrichment = emptyEnrichmentData;
    enrichment.earlyWarningTime = "17:55";

    const text = "🟡 Сирена!\n<b>Время оповещения:</b> 18:00";
    const result = buildEnrichedMessage(text, "red_alert", alertTs, enrichment);
    expect(result).not.toContain("Раннее предупреждение:");
  });
});

// ─── insertBeforeTimeLine ──────────────────────────────

describe("insertBeforeTimeLine", () => {
  it("inserts before Время оповещения line", () => {
    const text = "Header\n<b>Время оповещения:</b> 18:00";
    const result = insertBeforeTimeLine(text, "NEW LINE");
    expect(result.indexOf("NEW LINE")).toBeLessThan(
      result.indexOf("Время оповещения:"),
    );
  });

  it("inserts before last line if no time pattern", () => {
    const text = "Line1\nLine2\nLine3";
    const result = insertBeforeTimeLine(text, "NEW");
    const lines = result.split("\n");
    expect(lines[lines.length - 2]).toBe("NEW");
  });
});

// ─── COUNTRY_RU translations ───────────────────────────

describe("COUNTRY_RU", () => {
  it("maps all expected countries", () => {
    expect(COUNTRY_RU["Iran"]).toBe("Иран");
    expect(COUNTRY_RU["Yemen"]).toBe("Йемен");
    expect(COUNTRY_RU["Lebanon"]).toBe("Ливан");
    expect(COUNTRY_RU["Gaza"]).toBe("Газа");
  });
});

// ─── Confidence thresholds ─────────────────────────────

describe("confidence thresholds", () => {
  it("SKIP=0.6, UNCERTAIN=0.75, CERTAIN=0.95", () => {
    expect(SKIP).toBe(0.6);
    expect(UNCERTAIN).toBe(0.75);
    expect(CERTAIN).toBe(0.95);
  });
});
