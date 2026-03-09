/**
 * Tests for graph.ts internal functions.
 *
 * Split into two parts:
 *   1. Unit tests — no LLM, no network. Test pure functions exported via `_test`.
 *   2. Integration tests — call real OpenRouter API (skipped without OPENROUTER_API_KEY).
 *
 * Run only unit tests:  vitest run packages/bot/src/__tests__/graph.test.ts
 * Run with integration:  OPENROUTER_API_KEY=sk-... vitest run packages/bot/src/__tests__/graph.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      model: "google/gemini-2.0-flash-001",
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

vi.mock("../agent/redis.js", () => ({
  getRedis: vi.fn().mockReturnValue({
    lpush: vi.fn(),
    expire: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn(),
  }),
}));

vi.mock("../agent/store.js", () => ({
  pushSessionPost: vi.fn(),
  getActiveSession: vi.fn().mockResolvedValue(null),
  getChannelPosts: vi.fn().mockResolvedValue([]),
  getEnrichmentData: vi.fn().mockResolvedValue(null),
  saveEnrichmentData: vi.fn(),
}));

vi.mock("../agent/clarify.js", () => ({
  runClarify: vi.fn().mockResolvedValue({ votedResult: null }),
}));

// ── Import _test after mocks ─────────────────────────

let _test: typeof import("../agent/graph.js")["_test"];

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("../agent/graph.js");
  _test = mod._test;
});

afterEach(() => vi.restoreAllMocks());

// ═══════════════════════════════════════════════════════
// PART 1: UNIT TESTS (pure functions, no LLM)
// ═══════════════════════════════════════════════════════

// ─── textHash ──────────────────────────────────────────

describe("textHash", () => {
  it("returns stable hash for same input", () => {
    const h1 = _test.textHash("hello world");
    const h2 = _test.textHash("hello world");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{16,32}$/);
  });

  it("returns different hash for different input", () => {
    expect(_test.textHash("a")).not.toBe(_test.textHash("b"));
  });
});

// ─── toIsraelTime ──────────────────────────────────────

describe("toIsraelTime", () => {
  it("formats timestamp in Israel timezone", () => {
    // 2024-01-15T12:00:00Z
    const ts = new Date("2024-01-15T12:00:00Z").getTime();
    const result = _test.toIsraelTime(ts);
    // Israel is UTC+2 in winter → 14:00
    expect(result).toMatch(/14:00/);
  });
});

// ─── buildRegionKeywords ───────────────────────────────

describe("buildRegionKeywords", () => {
  it("includes configured areas and labels", () => {
    const kw = _test.buildRegionKeywords();
    expect(kw).toContain("הרצליה");
    expect(kw).toContain("герцлия");
  });

  it("includes common attack keywords", () => {
    const kw = _test.buildRegionKeywords();
    expect(kw).toContain("ישראל");
    expect(kw).toContain("ракет");
    expect(kw).toContain("iron dome");
  });

  it("deduplicates keywords", () => {
    const kw = _test.buildRegionKeywords();
    const unique = [...new Set(kw)];
    expect(kw.length).toBe(unique.length);
  });
});

// ─── LAUNCH_KEYWORDS ──────────────────────────────────

describe("LAUNCH_KEYWORDS", () => {
  it("includes Hebrew and Russian keywords", () => {
    expect(_test.LAUNCH_KEYWORDS).toContain("שיגור");
    expect(_test.LAUNCH_KEYWORDS).toContain("запуски ракет");
  });
});

// ─── TIME_WINDOW_MS ────────────────────────────────────

describe("TIME_WINDOW_MS", () => {
  it("has correct time windows per phase", () => {
    expect(_test.TIME_WINDOW_MS.early_warning).toBe(5 * 60_000);
    expect(_test.TIME_WINDOW_MS.siren).toBe(10 * 60_000);
    expect(_test.TIME_WINDOW_MS.resolved).toBe(30 * 60_000);
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
      confidence: 0.7,
      valid: true,
      ...overrides,
    };
  }

  function runPostFilter(extractions: ValidatedExtraction[]) {
    return _test.postFilter({
      alertId: "test-1",
      alertTs: Date.now(),
      alertType: "early_warning",
      alertAreas: ["הרצליה"],
      chatId: "123",
      messageId: 1,
      isCaption: false,
      currentText: "test",
      channelPosts: [],
      filteredPosts: [],
      extractions,
      votedResult: null,
      clarifyAttempted: false,
      previousEnrichment: emptyEnrichmentData(),
      sessionStartTs: Date.now() - 60_000,
      phaseStartTs: Date.now(),
    });
  }

  it("passes valid extraction", () => {
    const result = runPostFilter([makeExtraction()]);
    const exts = result.extractions!;
    expect(exts[0].valid).toBe(true);
  });

  it("rejects stale posts (time_relevance < 0.5)", () => {
    const result = runPostFilter([makeExtraction({ time_relevance: 0.3 })]);
    const exts = result.extractions!;
    expect(exts[0].valid).toBe(false);
    expect(exts[0].reject_reason).toBe("stale_post");
  });

  it("rejects region_irrelevant posts", () => {
    const result = runPostFilter([makeExtraction({ region_relevance: 0.2 })]);
    const exts = result.extractions!;
    expect(exts[0].valid).toBe(false);
    expect(exts[0].reject_reason).toBe("region_irrelevant");
  });

  it("rejects untrusted sources", () => {
    const result = runPostFilter([makeExtraction({ source_trust: 0.2 })]);
    const exts = result.extractions!;
    expect(exts[0].valid).toBe(false);
    expect(exts[0].reject_reason).toBe("untrusted_source");
  });

  it("rejects alarmist tone", () => {
    const result = runPostFilter([makeExtraction({ tone: "alarmist" })]);
    const exts = result.extractions!;
    expect(exts[0].valid).toBe(false);
    expect(exts[0].reject_reason).toBe("alarmist_tone");
  });

  it("rejects extraction with no data fields", () => {
    const result = runPostFilter([
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
    ]);
    const exts = result.extractions!;
    expect(exts[0].valid).toBe(false);
    expect(exts[0].reject_reason).toBe("no_data");
  });

  it("rejects low confidence", () => {
    const result = runPostFilter([makeExtraction({ confidence: 0.1 })]);
    const exts = result.extractions!;
    expect(exts[0].valid).toBe(false);
    expect(exts[0].reject_reason).toBe("low_confidence");
  });

  it("time_relevance is checked FIRST (before region)", () => {
    const result = runPostFilter([
      makeExtraction({ time_relevance: 0.1, region_relevance: 0.1 }),
    ]);
    // stale_post should be the reason, not region_irrelevant
    expect(result.extractions![0].reject_reason).toBe("stale_post");
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
      confidence: 0.8,
      valid: true,
      messageUrl: "https://t.me/test/1",
      ...overrides,
    };
  }

  function runVote(extractions: ValidatedExtraction[]) {
    return _test.vote({
      alertId: "test-1",
      alertTs: Date.now(),
      alertType: "early_warning",
      alertAreas: ["הרצליה"],
      chatId: "123",
      messageId: 1,
      isCaption: false,
      currentText: "test",
      channelPosts: [],
      filteredPosts: [],
      extractions,
      votedResult: null,
      clarifyAttempted: false,
      previousEnrichment: emptyEnrichmentData(),
      sessionStartTs: Date.now() - 60_000,
      phaseStartTs: Date.now(),
    });
  }

  it("returns null for empty valid extractions", () => {
    const result = runVote([makeValidExtraction({ valid: false })]);
    expect(result.votedResult).toBeNull();
  });

  it("aggregates country origins from multiple sources", () => {
    const result = runVote([
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
    ]);
    const v = result.votedResult!;
    expect(v).not.toBeNull();
    expect(v.country_origins).toHaveLength(1);
    expect(v.country_origins![0].name).toBe("Iran");
    expect(v.country_origins![0].citations).toHaveLength(2);
  });

  it("computes rocket count range", () => {
    const result = runVote([
      makeValidExtraction({ rocket_count: 10 }),
      makeValidExtraction({ rocket_count: 15 }),
    ]);
    const v = result.votedResult!;
    expect(v.rocket_count_min).toBe(10);
    expect(v.rocket_count_max).toBe(15);
    expect(v.rocket_citations).toHaveLength(2);
  });

  it("median injuries from multiple sources", () => {
    const result = runVote([
      makeValidExtraction({ injuries: 5 }),
      makeValidExtraction({ injuries: 3 }),
      makeValidExtraction({ injuries: 8 }),
    ]);
    const v = result.votedResult!;
    expect(v.injuries).toBe(5); // median of [3, 5, 8]
    expect(v.injuries_citations).toHaveLength(3);
  });

  it("sets citedSources with 1-based indices", () => {
    const result = runVote([
      makeValidExtraction({
        channel: "@a",
        messageUrl: "https://t.me/a/1",
      }),
      makeValidExtraction({
        channel: "@b",
        messageUrl: "https://t.me/b/1",
      }),
    ]);
    const v = result.votedResult!;
    expect(v.citedSources).toHaveLength(2);
    expect(v.citedSources[0].index).toBe(1);
    expect(v.citedSources[1].index).toBe(2);
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
    const result = _test.inlineCites([1, 2], sources);
    expect(result).toContain('<a href="https://t.me/a/1">[1]</a>');
    expect(result).toContain('<a href="https://t.me/b/2">[2]</a>');
  });

  it("skips indices without URLs", () => {
    const result = _test.inlineCites([3], sources);
    expect(result).toBe("");
  });

  it("returns empty string for no indices", () => {
    const result = _test.inlineCites([], sources);
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
    const result = _test.inlineCitesFromData(cites);
    expect(result).toContain('<a href="https://t.me/a/1">[1]</a>');
    expect(result).toContain('<a href="https://t.me/b/2">[2]</a>');
  });

  it("returns empty for empty array", () => {
    expect(_test.inlineCitesFromData([])).toBe("");
  });
});

// ─── extractCites ──────────────────────────────────────

describe("extractCites", () => {
  const sources: CitedSource[] = [
    { index: 1, channel: "@a", messageUrl: "https://t.me/a/1" },
    { index: 2, channel: "@b", messageUrl: null },
  ];

  it("returns InlineCite objects with url and channel", () => {
    const cites = _test.extractCites([1], sources);
    expect(cites).toHaveLength(1);
    expect(cites[0].url).toBe("https://t.me/a/1");
    expect(cites[0].channel).toBe("@a");
  });

  it("skips sources without messageUrl", () => {
    const cites = _test.extractCites([2], sources);
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
    const data = _test.buildEnrichmentFromVote(
      makeVoted(),
      emptyEnrichmentData(),
      "early_warning",
      alertTs,
    );
    expect(data.origin).toBe("Иран"); // Translated to Russian
    expect(data.originCites).toHaveLength(1);
    expect(data.originCites[0].url).toBe("https://t.me/a/1");
  });

  it("preserves carry-forward data from prev", () => {
    const prev = emptyEnrichmentData();
    prev.origin = "Йемен";
    prev.originCites = [{ url: "https://t.me/old/1", channel: "@old" }];

    // No country in new vote
    const voted = makeVoted({ country_origins: null });
    const data = _test.buildEnrichmentFromVote(voted, prev, "siren", alertTs);
    // Previous origin preserved
    expect(data.origin).toBe("Йемен");
    expect(data.originCites).toHaveLength(1);
  });

  it("sets ETA for early_warning", () => {
    const voted = makeVoted({ eta_refined_minutes: 5 });
    const data = _test.buildEnrichmentFromVote(
      voted,
      emptyEnrichmentData(),
      "early_warning",
      alertTs,
    );
    expect(data.etaAbsolute).toMatch(/^~\d{2}:\d{2}$/);
  });

  it("sets injuries for resolved phase", () => {
    const voted = makeVoted({ injuries: 3, injuries_confidence: 0.8 });
    const data = _test.buildEnrichmentFromVote(
      voted,
      emptyEnrichmentData(),
      "resolved",
      alertTs,
    );
    expect(data.injuries).toBe("3");
    expect(data.injuriesCites).toHaveLength(1);
  });

  it("records earlyWarningTime on first early_warning", () => {
    const data = _test.buildEnrichmentFromVote(
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
    const result = _test.buildEnrichedMessage(
      text,
      "early_warning",
      alertTs,
      enrichment,
    );
    expect(result).toContain("<b>Откуда:</b> Иран");
    expect(result).toContain('<a href="https://t.me/a/1">[1]</a>');
    // Origin should be before time line
    const originIdx = result.indexOf("Откуда:");
    const timeIdx = result.indexOf("Время оповещения:");
    expect(originIdx).toBeLessThan(timeIdx);
  });

  it("inserts rocket count with breakdown", () => {
    const enrichment = emptyEnrichmentData();
    enrichment.rocketCount = "~10–15";
    enrichment.intercepted = "8";
    enrichment.rocketCites = [{ url: "https://t.me/a/1", channel: "@a" }];

    const text = "🔴 Тревога!\n<b>Время оповещения:</b> 18:00";
    const result = _test.buildEnrichedMessage(
      text,
      "siren",
      alertTs,
      enrichment,
    );
    expect(result).toContain("<b>Ракет:</b> ~10–15");
    expect(result).toContain("перехвачено — 8");
  });

  it("inserts casualties/injuries only for resolved", () => {
    const enrichment = emptyEnrichmentData();
    enrichment.casualties = "2";
    enrichment.injuries = "5";
    enrichment.casualtiesCites = [{ url: "https://t.me/a/1", channel: "@a" }];
    enrichment.injuriesCites = [{ url: "https://t.me/b/1", channel: "@b" }];

    const text = "✅ Отбой\n<b>Время оповещения:</b> 18:00";
    const resultResolved = _test.buildEnrichedMessage(
      text,
      "resolved",
      alertTs,
      enrichment,
    );
    expect(resultResolved).toContain("<b>Погибшие:</b> 2");
    expect(resultResolved).toContain("<b>Пострадавшие:</b> 5");

    // NOT in siren phase
    const resultSiren = _test.buildEnrichedMessage(
      text,
      "siren",
      alertTs,
      enrichment,
    );
    expect(resultSiren).not.toContain("Погибшие:");
    expect(resultSiren).not.toContain("Пострадавшие:");
  });

  it("inserts early warning time in siren phase", () => {
    const enrichment = emptyEnrichmentData();
    enrichment.earlyWarningTime = "17:55";

    const text = "🟡 Сирена!\n<b>Время оповещения:</b> 18:00";
    const result = _test.buildEnrichedMessage(
      text,
      "siren",
      alertTs,
      enrichment,
    );
    expect(result).toContain("Раннее предупреждение:");
    expect(result).toContain("17:55");
  });
});

// ─── insertBeforeTimeLine ──────────────────────────────

describe("insertBeforeTimeLine", () => {
  it("inserts before Время оповещения line", () => {
    const text = "Header\n<b>Время оповещения:</b> 18:00";
    const result = _test.insertBeforeTimeLine(text, "NEW LINE");
    expect(result.indexOf("NEW LINE")).toBeLessThan(
      result.indexOf("Время оповещения:"),
    );
  });

  it("inserts before last line if no time pattern", () => {
    const text = "Line1\nLine2\nLine3";
    const result = _test.insertBeforeTimeLine(text, "NEW");
    const lines = result.split("\n");
    expect(lines[lines.length - 2]).toBe("NEW");
  });
});

// ─── getPhaseInstructions ──────────────────────────────

describe("getPhaseInstructions", () => {
  it("returns early_warning instructions", () => {
    const inst = _test.getPhaseInstructions("early_warning");
    expect(inst).toContain("EARLY WARNING");
    expect(inst).toContain("country_origin");
    expect(inst).toContain("Do NOT extract: intercepted");
  });

  it("returns siren instructions", () => {
    const inst = _test.getPhaseInstructions("siren");
    expect(inst).toContain("SIREN");
    expect(inst).toContain("intercepted");
  });

  it("returns resolved instructions", () => {
    const inst = _test.getPhaseInstructions("resolved");
    expect(inst).toContain("RESOLVED");
    expect(inst).toContain("casualties");
    expect(inst).toContain("injuries");
  });
});

// ─── SYSTEM_PROMPT_BASE ────────────────────────────────

describe("SYSTEM_PROMPT_BASE", () => {
  it("contains time validation instructions", () => {
    expect(_test.SYSTEM_PROMPT_BASE).toContain("TIME VALIDATION");
    expect(_test.SYSTEM_PROMPT_BASE).toContain("time_relevance");
  });

  it("contains language neutrality rule", () => {
    expect(_test.SYSTEM_PROMPT_BASE).toContain("LANGUAGE NEUTRALITY");
    expect(_test.SYSTEM_PROMPT_BASE).toContain(
      "MUST NOT affect source_trust or confidence",
    );
  });
});

// ─── COUNTRY_RU translations ───────────────────────────

describe("COUNTRY_RU", () => {
  it("maps all expected countries", () => {
    expect(_test.COUNTRY_RU["Iran"]).toBe("Иран");
    expect(_test.COUNTRY_RU["Yemen"]).toBe("Йемен");
    expect(_test.COUNTRY_RU["Lebanon"]).toBe("Ливан");
    expect(_test.COUNTRY_RU["Gaza"]).toBe("Газа");
  });
});

// ─── Confidence thresholds ─────────────────────────────

describe("confidence thresholds", () => {
  it("SKIP=0.6, UNCERTAIN=0.75, CERTAIN=0.95", () => {
    expect(_test.SKIP).toBe(0.6);
    expect(_test.UNCERTAIN).toBe(0.75);
    expect(_test.CERTAIN).toBe(0.95);
  });
});

// ═══════════════════════════════════════════════════════
// PART 2: INTEGRATION TESTS (real OpenRouter API)
// ═══════════════════════════════════════════════════════

const HAS_API_KEY = !!process.env.OPENROUTER_API_KEY;
const describeIntegration = HAS_API_KEY ? describe : describe.skip;

describeIntegration("LLM integration (real OpenRouter)", () => {
  // These tests call the actual OpenRouter API. They are slow (~2-5s each)
  // and require OPENROUTER_API_KEY env var.

  let llm: ReturnType<typeof _test.getLLM>;
  const systemPrompt =
    _test?.SYSTEM_PROMPT_BASE +
    "\n\n" +
    (_test?.getPhaseInstructions("early_warning") ?? "");

  beforeEach(() => {
    llm = _test.getLLM();
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

    const postText = `🔴 زפיקוד העורף: ירי רקטות מאיראן לעבר שטח ישראל. היכנסו למרחב המוגן`;

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
      const postTimeIL = "15:00"; // 2.5 hours BEFORE alert
      const contextHeader =
        `Alert time: ${alertTimeIL} (Israel)\n` +
        `Post time:  ${postTimeIL} (Israel) (150 min BEFORE alert)\n` +
        `Current time: 17:35 (Israel)\n` +
        `Alert region: הרצליה, תל אביב\n` +
        `UI language: ru\n`;

      // This simulates the exact Lebanon bug — old post about a previous attack
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

      // This is the critical assertion — the Lebanon bug is fixed
      // when time_relevance is low enough to be rejected by postFilter
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

      // Same factual content in Russian
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

      // Russian post should still get high trust and confidence
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
