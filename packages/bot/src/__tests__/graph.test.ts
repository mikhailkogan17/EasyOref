/**
 * Tests for enrichment pipeline functions.
 *
 * Split into two parts:
 *   1. Unit tests — no LLM, no network. Test pure functions from extract, vote, message, helpers.
 *   2. Integration tests — call real OpenRouter API (skipped without OPENROUTER_API_KEY).
 *
 * Run only unit tests:  vitest run packages/bot/src/__tests__/graph.test.ts
 * Run with integration:  OPENROUTER_API_KEY=sk-... vitest run packages/bot/src/__tests__/graph.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CitedSource,
  ExtractionResult,
  InlineCite,
  ValidatedExtraction,
  VotedResult,
} from "../agent/types.js";
import { emptyEnrichmentData } from "../agent/types.js";

// ── Mocks — minimal, only for config & logger ─────────

vi.mock("../config.js", () => ({
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
}));

vi.mock("../logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("../agent/store.js", () => ({
  pushSessionPost: vi.fn(),
  getActiveSession: vi.fn().mockResolvedValue(null),
  getChannelPosts: vi.fn().mockResolvedValue([]),
  getEnrichmentData: vi.fn().mockResolvedValue(null),
  saveEnrichmentData: vi.fn(),
  getCachedExtractions: vi.fn().mockResolvedValue(new Map()),
  saveCachedExtractions: vi.fn(),
  getLastUpdateTs: vi.fn().mockResolvedValue(0),
  setLastUpdateTs: vi.fn(),
}));

// ── Imports (after mocks are hoisted) ──────────────────

import {
  EXTRACT_SYSTEM_PROMPT,
  getExtractLLM,
  getPhaseInstructions,
  postFilter,
} from "../agent/extract.js";
import { textHash, toIsraelTime } from "../agent/helpers.js";
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
} from "../agent/message.js";
import { vote } from "../agent/vote.js";

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
      region_relevance: 0.9,
      source_trust: 0.8,
      tone: "calm" as const,
      time_relevance: 0.9,
      country_origin: "Iran",
      rocket_count: 10,
      is_cassette: null,
      intercepted: null,
      intercepted_qual: null,
      intercepted_qual_num: null,
      sea_impact: null,
      sea_impact_qual: null,
      sea_impact_qual_num: null,
      open_area_impact: null,
      open_area_impact_qual: null,
      open_area_impact_qual_num: null,
      hits_confirmed: null,
      casualties: null,
      injuries: null,
      eta_refined_minutes: null,
      rocket_detail: null,
      confidence: 0.7,
      valid: true,
      ...overrides,
    };
  }

  it("passes valid extraction", () => {
    const result = postFilter([makeExtraction()], "test-1");
    expect(result[0].valid).toBe(true);
  });

  it("rejects stale posts (time_relevance < 0.5)", () => {
    const result = postFilter(
      [makeExtraction({ time_relevance: 0.3 })],
      "test-1",
    );
    expect(result[0].valid).toBe(false);
    expect(result[0].reject_reason).toBe("stale_post");
  });

  it("rejects region_irrelevant posts", () => {
    const result = postFilter(
      [makeExtraction({ region_relevance: 0.2 })],
      "test-1",
    );
    expect(result[0].valid).toBe(false);
    expect(result[0].reject_reason).toBe("region_irrelevant");
  });

  it("rejects untrusted sources", () => {
    const result = postFilter(
      [makeExtraction({ source_trust: 0.2 })],
      "test-1",
    );
    expect(result[0].valid).toBe(false);
    expect(result[0].reject_reason).toBe("untrusted_source");
  });

  it("rejects alarmist tone", () => {
    const result = postFilter([makeExtraction({ tone: "alarmist" })], "test-1");
    expect(result[0].valid).toBe(false);
    expect(result[0].reject_reason).toBe("alarmist_tone");
  });

  it("rejects extraction with no data fields", () => {
    const result = postFilter(
      [
        makeExtraction({
          country_origin: null,
          rocket_count: null,
          is_cassette: null,
          intercepted: null,
          intercepted_qual: null,
          hits_confirmed: null,
          casualties: null,
          injuries: null,
          eta_refined_minutes: null,
        }),
      ],
      "test-1",
    );
    expect(result[0].valid).toBe(false);
    expect(result[0].reject_reason).toBe("no_data");
  });

  it("rejects low confidence", () => {
    const result = postFilter([makeExtraction({ confidence: 0.1 })], "test-1");
    expect(result[0].valid).toBe(false);
    expect(result[0].reject_reason).toBe("low_confidence");
  });

  it("time_relevance is checked FIRST (before region)", () => {
    const result = postFilter(
      [makeExtraction({ time_relevance: 0.1, region_relevance: 0.1 })],
      "test-1",
    );
    expect(result[0].reject_reason).toBe("stale_post");
  });
});

// ─── vote ──────────────────────────────────────────────

describe("vote", () => {
  function makeValidExtraction(
    overrides: Partial<ValidatedExtraction> = {},
  ): ValidatedExtraction {
    return {
      channel: "@test",
      region_relevance: 0.9,
      source_trust: 0.8,
      tone: "calm" as const,
      time_relevance: 0.9,
      country_origin: "Iran",
      rocket_count: 10,
      is_cassette: null,
      intercepted: null,
      intercepted_qual: null,
      intercepted_qual_num: null,
      sea_impact: null,
      sea_impact_qual: null,
      sea_impact_qual_num: null,
      open_area_impact: null,
      open_area_impact_qual: null,
      open_area_impact_qual_num: null,
      hits_confirmed: null,
      casualties: null,
      injuries: null,
      eta_refined_minutes: null,
      rocket_detail: null,
      confidence: 0.8,
      valid: true,
      messageUrl: "https://t.me/test/1",
      ...overrides,
    };
  }

  it("returns null for empty valid extractions", () => {
    const result = vote([makeValidExtraction({ valid: false })], "test-1");
    expect(result).toBeNull();
  });

  it("aggregates country origins from multiple sources", () => {
    const result = vote(
      [
        makeValidExtraction({
          channel: "@a",
          country_origin: "Iran",
          messageUrl: "https://t.me/a/1",
        }),
        makeValidExtraction({
          channel: "@b",
          country_origin: "Iran",
          messageUrl: "https://t.me/b/1",
        }),
      ],
      "test-1",
    );
    expect(result).not.toBeNull();
    expect(result!.country_origins).toHaveLength(1);
    expect(result!.country_origins![0].name).toBe("Iran");
    expect(result!.country_origins![0].citations).toHaveLength(2);
  });

  it("computes rocket count range", () => {
    const result = vote(
      [
        makeValidExtraction({ rocket_count: 10 }),
        makeValidExtraction({ rocket_count: 15 }),
      ],
      "test-1",
    );
    expect(result!.rocket_count_min).toBe(10);
    expect(result!.rocket_count_max).toBe(15);
    expect(result!.rocket_citations).toHaveLength(2);
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
    expect(result!.injuries_citations).toHaveLength(3);
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
    { index: 3, channel: "@c", messageUrl: null },
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
    const data = emptyEnrichmentData();
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
    const map = buildGlobalCiteMap(emptyEnrichmentData());
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
    { index: 2, channel: "@b", messageUrl: null },
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
      eta_refined_minutes: null,
      eta_citations: [],
      country_origins: [{ name: "Iran", citations: [1] }],
      rocket_count_min: 10,
      rocket_count_max: 15,
      rocket_citations: [1, 2],
      rocket_confidence: 0.8,
      is_cassette: null,
      is_cassette_confidence: 0,
      intercepted: 8,
      intercepted_qual: null,
      intercepted_qual_num: null,
      intercepted_confidence: 0.7,
      sea_impact: null,
      sea_impact_qual: null,
      sea_impact_qual_num: null,
      sea_confidence: 0,
      open_area_impact: null,
      open_area_impact_qual: null,
      open_area_impact_qual_num: null,
      open_area_confidence: 0,
      hits_confirmed: 1,
      hits_citations: [2],
      hits_confidence: 0.7,
      no_impacts: false,
      no_impacts_citations: [],
      intercepted_citations: [1],
      rocket_detail: null,
      casualties: null,
      casualties_citations: [],
      casualties_confidence: 0,
      injuries: 3,
      injuries_citations: [1],
      injuries_confidence: 0.7,
      confidence: 0.75,
      sources_count: 2,
      citedSources: [
        { index: 1, channel: "@a", messageUrl: "https://t.me/a/1" },
        { index: 2, channel: "@b", messageUrl: "https://t.me/b/2" },
      ],
      ...overrides,
    };
  }

  it("sets origin from voted country_origins", () => {
    const data = buildEnrichmentFromVote(
      makeVoted(),
      emptyEnrichmentData(),
      "early_warning",
      alertTs,
    );
    expect(data.origin).toBe("Иран");
    expect(data.originCites).toHaveLength(1);
    expect(data.originCites[0].url).toBe("https://t.me/a/1");
  });

  it("preserves carry-forward data from prev", () => {
    const prev = emptyEnrichmentData();
    prev.origin = "Йемен";
    prev.originCites = [{ url: "https://t.me/old/1", channel: "@old" }];

    const voted = makeVoted({ country_origins: null });
    const data = buildEnrichmentFromVote(voted, prev, "siren", alertTs);
    expect(data.origin).toBe("Йемен");
    expect(data.originCites).toHaveLength(1);
  });

  it("sets ETA for early_warning", () => {
    const voted = makeVoted({ eta_refined_minutes: 5 });
    const data = buildEnrichmentFromVote(
      voted,
      emptyEnrichmentData(),
      "early_warning",
      alertTs,
    );
    expect(data.etaAbsolute).toMatch(/^~\d{2}:\d{2}$/);
  });

  it("sets injuries for resolved phase", () => {
    const voted = makeVoted({ injuries: 3, injuries_confidence: 0.8 });
    const data = buildEnrichmentFromVote(
      voted,
      emptyEnrichmentData(),
      "resolved",
      alertTs,
    );
    expect(data.injuries).toBe("3");
    expect(data.injuriesCites).toHaveLength(1);
  });

  it("records earlyWarningTime on first early_warning", () => {
    const data = buildEnrichmentFromVote(
      makeVoted(),
      emptyEnrichmentData(),
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
    const enrichment = emptyEnrichmentData();
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
    const enrichment = emptyEnrichmentData();
    enrichment.rocketCount = "~10–15";
    enrichment.intercepted = "8";
    enrichment.rocketCites = [{ url: "https://t.me/a/1", channel: "@a" }];
    enrichment.interceptedCites = [{ url: "https://t.me/b/1", channel: "@b" }];

    const text = "🔴 Тревога!\n<b>Время оповещения:</b> 18:00";
    const result = buildEnrichedMessage(text, "siren", alertTs, enrichment);
    expect(result).toContain("<b>Ракет:</b> ~10–15");
    expect(result).toContain("<b>Перехваты:</b> 8");
    expect(result).not.toContain("из них");
  });

  it("inserts casualties/injuries only for resolved", () => {
    const enrichment = emptyEnrichmentData();
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
      "siren",
      alertTs,
      enrichment,
    );
    expect(resultSiren).not.toContain("Погибшие:");
    expect(resultSiren).not.toContain("Пострадавшие:");
  });

  it("does not insert early warning time in siren phase (replaced by reply chain)", () => {
    const enrichment = emptyEnrichmentData();
    enrichment.earlyWarningTime = "17:55";

    const text = "🟡 Сирена!\n<b>Время оповещения:</b> 18:00";
    const result = buildEnrichedMessage(text, "siren", alertTs, enrichment);
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

// ─── getPhaseInstructions ──────────────────────────────

describe("getPhaseInstructions", () => {
  it("returns early_warning instructions", () => {
    const inst = getPhaseInstructions("early_warning");
    expect(inst).toContain("EARLY WARNING");
    expect(inst).toContain("country_origin");
    expect(inst).toContain("Do NOT extract: intercepted");
  });

  it("returns siren instructions", () => {
    const inst = getPhaseInstructions("siren");
    expect(inst).toContain("SIREN");
    expect(inst).toContain("intercepted");
  });

  it("returns resolved instructions", () => {
    const inst = getPhaseInstructions("resolved");
    expect(inst).toContain("RESOLVED");
    expect(inst).toContain("casualties");
    expect(inst).toContain("injuries");
  });
});

// ─── EXTRACT_SYSTEM_PROMPT ─────────────────────────────

describe("EXTRACT_SYSTEM_PROMPT", () => {
  it("contains time validation instructions", () => {
    expect(EXTRACT_SYSTEM_PROMPT).toContain("TIME VALIDATION");
    expect(EXTRACT_SYSTEM_PROMPT).toContain("time_relevance");
  });

  it("contains language neutrality rule", () => {
    expect(EXTRACT_SYSTEM_PROMPT).toContain("LANGUAGE NEUTRALITY");
    expect(EXTRACT_SYSTEM_PROMPT).toContain(
      "MUST NOT affect source_trust or confidence",
    );
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

// ═══════════════════════════════════════════════════════
// PART 2: INTEGRATION TESTS (real OpenRouter API)
// ═══════════════════════════════════════════════════════

const HAS_API_KEY = !!process.env.OPENROUTER_API_KEY;
const describeIntegration = HAS_API_KEY ? describe : describe.skip;

describeIntegration("LLM integration (real OpenRouter)", () => {
  let llm: ReturnType<typeof getExtractLLM>;
  let systemPrompt: string;

  beforeEach(() => {
    systemPrompt =
      EXTRACT_SYSTEM_PROMPT + "\n\n" + getPhaseInstructions("early_warning");
    llm = getExtractLLM();
  });

  it("extracts Iran origin from real post", { timeout: 30_000 }, async () => {
    const alertTimeIL = "17:30";
    const postTimeIL = "17:31";
    const contextHeader =
      `Alert time: ${alertTimeIL} (Israel)\n` +
      `Post time:  ${postTimeIL} (Israel) (1 min AFTER alert)\n` +
      `Current time: ${alertTimeIL} (Israel)\n` +
      `Alert region: הרצליה, תל אביב\n` +
      `UI language: ru\n`;

    const postText = `🔴 זפיקוד העורף: ירי רקטות מאיראן לעבר שטח ישראל. היכנסו למרחב המוגן`;

    const response = await llm.invoke([
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `${contextHeader}Channel: @idf_telegram\n\nMessage:\n${postText}`,
      },
    ]);

    const raw =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);
    const text = raw
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "");
    const parsed = JSON.parse(text.trim()) as ExtractionResult;

    expect(parsed.country_origin).toBe("Iran");
    expect(parsed.time_relevance).toBeGreaterThanOrEqual(0.7);
    expect(parsed.region_relevance).toBeGreaterThan(0.5);
  });

  it(
    "sets low time_relevance for stale Lebanon post",
    { timeout: 30_000 },
    async () => {
      const alertTimeIL = "17:30";
      const postTimeIL = "15:00";
      const contextHeader =
        `Alert time: ${alertTimeIL} (Israel)\n` +
        `Post time:  ${postTimeIL} (Israel) (150 min BEFORE alert)\n` +
        `Current time: 17:35 (Israel)\n` +
        `Alert region: הרצליה, תל אביב\n` +
        `UI language: ru\n`;

      const postText = `עדכון צה"ל: כוחות צה"ל תקפו מטרות של חיזבאללה בלבנון. הותקפו עשרות מטרות בדרום לבנון`;

      const response = await llm.invoke([
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `${contextHeader}Channel: @N12LIVE\n\nMessage:\n${postText}`,
        },
      ]);

      const raw =
        typeof response.content === "string"
          ? response.content
          : JSON.stringify(response.content);
      const text = raw
        .replace(/^```(?:json)?\s*\n?/i, "")
        .replace(/\n?```\s*$/i, "");
      const parsed = JSON.parse(text.trim()) as ExtractionResult;

      expect(parsed.time_relevance).toBeLessThan(0.5);
    },
  );

  it(
    "Russian-language posts get same confidence as Hebrew (language neutrality)",
    { timeout: 30_000 },
    async () => {
      const alertTimeIL = "17:30";
      const postTimeIL = "17:31";
      const contextHeader =
        `Alert time: ${alertTimeIL} (Israel)\n` +
        `Post time:  ${postTimeIL} (Israel) (1 min AFTER alert)\n` +
        `Current time: 17:35 (Israel)\n` +
        `Alert region: הרצליה, תל אביב\n` +
        `UI language: ru\n`;

      const postRu = `⚡️ Ракетный обстрел из Ирана по центру Израиля. Зафиксировано не менее 15 ракет. Населению войти в укрытие.`;

      const responseRu = await llm.invoke([
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `${contextHeader}Channel: @israelinfo\n\nMessage:\n${postRu}`,
        },
      ]);

      const rawRu =
        typeof responseRu.content === "string"
          ? responseRu.content
          : JSON.stringify(responseRu.content);
      const textRu = rawRu
        .replace(/^```(?:json)?\s*\n?/i, "")
        .replace(/\n?```\s*$/i, "");
      const parsedRu = JSON.parse(textRu.trim()) as ExtractionResult;

      expect(parsedRu.source_trust).toBeGreaterThanOrEqual(0.6);
      expect(parsedRu.confidence).toBeGreaterThanOrEqual(0.6);
      expect(parsedRu.country_origin).toBe("Iran");
      expect(parsedRu.rocket_count).toBeGreaterThanOrEqual(10);
    },
  );

  it("rejects alarmist panic posts", { timeout: 30_000 }, async () => {
    const alertTimeIL = "17:30";
    const postTimeIL = "17:32";
    const contextHeader =
      `Alert time: ${alertTimeIL} (Israel)\n` +
      `Post time:  ${postTimeIL} (Israel) (2 min AFTER alert)\n` +
      `Current time: 17:35 (Israel)\n` +
      `Alert region: הרצליה, תל אביב\n` +
      `UI language: ru\n`;

    const postPanic = `‼️‼️‼️ СОТНИ РАКЕТ ЛЕТЯТ НА НАС!!!!! ВСЕ В УКРЫТИЕ СРОЧНО!!! КОНЕЦ СВЕТА!!!! 🔥🔥🔥 НЕВЕРОЯТНОЕ КОЛИЧЕСТВО РАКЕТ!!!!! МЫ ВСЕ УМРЁМ`;

    const response = await llm.invoke([
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `${contextHeader}Channel: @panic_channel\n\nMessage:\n${postPanic}`,
      },
    ]);

    const raw =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);
    const text = raw
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "");
    const parsed = JSON.parse(text.trim()) as ExtractionResult;

    expect(parsed.tone).toBe("alarmist");
    expect(parsed.source_trust).toBeLessThan(0.4);
  });
});
