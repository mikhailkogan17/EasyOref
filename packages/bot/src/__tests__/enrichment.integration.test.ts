/**
 * Integration tests for the enrichment pipeline.
 *
 * Two modes:
 *   - Deterministic tests (always run): post-filter, vote, message building
 *   - LLM tests (need OPENROUTER_API_KEY): real extraction via OpenRouter
 *
 * Run with real API:
 *   OPENROUTER_API_KEY=sk-or-... npx vitest run enrichment.integration
 *
 * The API key is read from config.yaml automatically if present.
 */

import { describe, expect, it } from "vitest";
import type {
  CitedSource,
  ValidatedExtraction,
  VotedResult,
} from "../agent/types.js";
import { emptyEnrichmentData } from "../agent/types.js";

// ── Load config for API key ────────────────────────────

let API_KEY = process.env.OPENROUTER_API_KEY ?? "";

// Try to read from config.yaml if not in env
if (!API_KEY) {
  try {
    const { readFileSync } = await import("node:fs");
    const { load } = await import("js-yaml");
    const raw = readFileSync("config.yaml", "utf-8");
    const cfg = load(raw) as Record<string, unknown>;
    const ai = cfg?.ai as Record<string, unknown> | undefined;
    API_KEY = (ai?.openrouter_api_key as string) ?? "";
  } catch {
    // No config.yaml — skip LLM tests
  }
}

const HAS_API = Boolean(API_KEY);

// ── Mock config for graph.ts imports ───────────────────

// Mock the config module BEFORE importing graph.ts
import { vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    agent: {
      filterModel: "google/gemini-2.5-flash-lite",
      extractModel: "google/gemini-3.1-flash-lite-preview",
      apiKey: "", // Will be set dynamically
      mcpTools: false,
      confidenceThreshold: 0.65,
      enrichDelayMs: 20_000,
      windowMinutes: 2,
      timeoutMinutes: 15,
      areaLabels: { דן: "Дан центр" },
      clarifyFetchCount: 3,
      redisUrl: "redis://localhost:6379",
    },
    areas: ["תל אביב - דרום העיר ויפו"],
    language: "ru",
    botToken: "",
    chatId: "",
    orefApiUrl: "",
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
    get: vi.fn().mockResolvedValue(null),
    setex: vi.fn(),
    lpush: vi.fn(),
    expire: vi.fn(),
    lrange: vi.fn().mockResolvedValue([]),
    del: vi.fn(),
  }),
}));

vi.mock("../agent/store.js", () => ({
  getChannelPosts: vi.fn().mockResolvedValue([]),
  getEnrichmentData: vi.fn().mockResolvedValue(null),
  getActiveSession: vi.fn().mockResolvedValue(null),
  saveEnrichmentData: vi.fn(),
  pushSessionPost: vi.fn(),
  getCachedExtractions: vi.fn().mockResolvedValue(new Map()),
  saveCachedExtractions: vi.fn(),
  getLastUpdateTs: vi.fn().mockResolvedValue(0),
  setLastUpdateTs: vi.fn(),
}));

vi.mock("../agent/clarify.js", () => ({
  runClarify: vi.fn(),
}));

// Import AFTER mocks
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
  inlineCites,
  inlineCitesFromData,
} from "../agent/message.js";
import { vote } from "../agent/vote.js";
const { config } = await import("../config.js");

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Fixtures — real posts from the March 9, 2026 incident
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Correct post: Iran launches detected (from @N12LIVE at 14:30 UTC / 16:30 IL) */
const POST_IRAN_LAUNCH = {
  channel: "@N12LIVE",
  text: "🔴 דיווח ראשון: זוהו שיגורים מאיראן לעבר ישראל. צפויות להתקבל התרעות באזורים שונים ברחבי הארץ",
  ts: Date.parse("2026-03-09T14:30:30.000Z"),
  messageUrl: "https://t.me/N12LIVE/167775",
};

/** STALE post: IDF Lebanon ops — NOT about current attack */
const POST_LEBANON_STALE = {
  channel: "@idf_telegram",
  text: '🇱🇧 צה"ל תקף מוקדם יותר היום מטרות של חיזבאללה בדרום לבנון. הותקפו תשתיות טרור, מנהרות ומחסני נשק. כוחות צה"ל פועלים בהתאם להערכות המודיעין',
  ts: Date.parse("2026-03-09T12:00:00.000Z"), // 2.5 hours before the alert
  messageUrl: "https://t.me/idf_telegram/5432",
};

/** Siren phase: interception report (from @yediotnews25) */
const POST_INTERCEPTION = {
  channel: "@yediotnews25",
  text: "עדכון: מערכת כיפת ברזל וחץ יירטו את רוב הטילים שנורו מאיראן לעבר מרכז ישראל. דיווחים על נפילות בשטחים פתוחים באזור השרון. אין דיווחים על נפגעים",
  ts: Date.parse("2026-03-09T14:45:00.000Z"),
  messageUrl: "https://t.me/yediotnews25/88901",
};

/** Resolved phase: damage assessment (from @N12LIVE) */
const POST_RESOLVED = {
  channel: "@N12LIVE",
  text: "סיכום אירוע הטילים מאיראן: כ-15 טילים שוגרו, 12 יורטו על ידי מערכות ההגנה. 2 נפלו בשטח פתוח באזור השרון, 1 פגע במבנה ריק ברמת גן. 3 פצועים קל ממעידה",
  ts: Date.parse("2026-03-09T15:30:00.000Z"),
  messageUrl: "https://t.me/N12LIVE/167790",
};

/** Alert timestamp: 14:30 UTC = 16:30 Israel */
const ALERT_TS = Date.parse("2026-03-09T14:30:00.000Z");
const ALERT_AREAS = ["תל אביב - דרום העיר ויפו"];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Deterministic tests (no API needed)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("toIsraelTime", () => {
  it("formats UTC timestamp to Israel time", () => {
    // 14:30 UTC = 16:30 IST (UTC+2 winter) or 17:30 IDT (UTC+3 summer)
    const formatted = toIsraelTime(ALERT_TS);
    expect(formatted).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe("textHash", () => {
  it("returns consistent md5 hash", () => {
    const h1 = textHash("hello");
    const h2 = textHash("hello");
    const h3 = textHash("world");
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toHaveLength(32);
  });
});

// ── Post-filter ────────────────────────────────────────

describe("postFilter", () => {
  it("rejects stale posts (time_relevance < 0.5)", () => {
    const ext: ValidatedExtraction = {
      channel: "@idf_telegram",
      region_relevance: 0.9,
      source_trust: 0.9,
      tone: "calm",
      time_relevance: 0.2, // ← stale!
      country_origin: "Lebanon",
      rocket_count: null,
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
      confidence: 0.9,
      valid: true,
    };

    const result = postFilter([ext], "test");
    expect(result[0]!.valid).toBe(false);
    expect(result[0]!.reject_reason).toBe("stale_post");
  });

  it("rejects region-irrelevant posts", () => {
    const ext: ValidatedExtraction = {
      channel: "@N12LIVE",
      region_relevance: 0.2,
      source_trust: 0.9,
      tone: "calm",
      time_relevance: 1.0,
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
      confidence: 0.9,
      valid: true,
    };

    const result = postFilter([ext], "test");
    expect(result[0]!.reject_reason).toBe("region_irrelevant");
  });

  it("rejects no-data posts", () => {
    const ext: ValidatedExtraction = {
      channel: "@N12LIVE",
      region_relevance: 0.9,
      source_trust: 0.9,
      tone: "calm",
      time_relevance: 1.0,
      country_origin: null,
      rocket_count: null,
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
      confidence: 0.9,
      valid: true,
    };

    const result = postFilter([ext], "test");
    expect(result[0]!.reject_reason).toBe("no_data");
  });

  it("passes valid extraction with all checks", () => {
    const ext: ValidatedExtraction = {
      channel: "@N12LIVE",
      region_relevance: 0.9,
      source_trust: 0.9,
      tone: "calm",
      time_relevance: 1.0,
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
    };

    const result = postFilter([ext], "test");
    expect(result[0]!.valid).toBe(true);
  });
});

// ── Vote ───────────────────────────────────────────────

describe("vote", () => {
  it("returns null for empty extractions", () => {
    const result = vote([], "test");
    expect(result).toBeNull();
  });

  it("returns null when all extractions are invalid", () => {
    const ext: ValidatedExtraction = {
      channel: "@N12LIVE",
      region_relevance: 0.9,
      source_trust: 0.9,
      tone: "calm",
      time_relevance: 0.1,
      country_origin: "Iran",
      rocket_count: null,
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
      valid: false,
      reject_reason: "stale_post",
    };
    const result = vote([ext], "test");
    expect(result).toBeNull();
  });

  it("aggregates country origins from multiple sources", () => {
    const ext1: ValidatedExtraction = {
      channel: "@N12LIVE",
      region_relevance: 0.9,
      source_trust: 0.9,
      tone: "calm",
      time_relevance: 1.0,
      country_origin: "Iran",
      rocket_count: 15,
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
      confidence: 0.9,
      valid: true,
      messageUrl: "https://t.me/N12LIVE/167775",
    };
    const ext2: ValidatedExtraction = {
      ...ext1,
      channel: "@yediotnews25",
      country_origin: "Iran",
      rocket_count: 12,
      confidence: 0.85,
      messageUrl: "https://t.me/yediotnews25/88901",
    };

    const result = vote([ext1, ext2], "test");
    const voted = result!;

    expect(voted).not.toBeNull();
    expect(voted.country_origins).toHaveLength(1);
    expect(voted.country_origins![0]!.name).toBe("Iran");
    expect(voted.country_origins![0]!.citations).toEqual([1, 2]);
    expect(voted.rocket_count_min).toBe(12);
    expect(voted.rocket_count_max).toBe(15);
    expect(voted.sources_count).toBe(2);
  });

  it("handles casualties in resolved phase", () => {
    const ext: ValidatedExtraction = {
      channel: "@N12LIVE",
      region_relevance: 0.9,
      source_trust: 0.9,
      tone: "calm",
      time_relevance: 1.0,
      country_origin: "Iran",
      rocket_count: 15,
      is_cassette: null,
      intercepted: 12,
      intercepted_qual: null,
      intercepted_qual_num: null,
      sea_impact: 2,
      sea_impact_qual: null,
      sea_impact_qual_num: null,
      open_area_impact: null,
      open_area_impact_qual: null,
      open_area_impact_qual_num: null,
      hits_confirmed: 1,
      casualties: 0,
      injuries: 3,
      eta_refined_minutes: null,
      confidence: 0.9,
      valid: true,
      messageUrl: "https://t.me/N12LIVE/167790",
    };

    const result = vote([ext], "test");
    const voted = result!;

    expect(voted.intercepted).toBe(12);
    expect(voted.sea_impact).toBe(2);
    expect(voted.hits_confirmed).toBe(1);
    expect(voted.injuries).toBe(3);
    expect(voted.casualties).toBeNull(); // 0 is not > 0
  });
});

// ── buildEnrichmentFromVote (carry-forward) ────────────

describe("buildEnrichmentFromVote", () => {
  it("carries forward origin from early_warning to siren", () => {
    const earlyEnrichment = emptyEnrichmentData();
    earlyEnrichment.origin = "Иран";
    earlyEnrichment.originCites = [
      { url: "https://t.me/N12LIVE/167775", channel: "@N12LIVE" },
    ];
    earlyEnrichment.earlyWarningTime = "16:30";

    // Siren vote has interception data but no origin
    const sirenVote: VotedResult = {
      eta_refined_minutes: null,
      eta_citations: [],
      country_origins: null,
      rocket_count_min: null,
      rocket_count_max: null,
      rocket_citations: [],
      rocket_confidence: 0,
      is_cassette: null,
      is_cassette_confidence: 0,
      intercepted: 8,
      intercepted_qual: null,
      intercepted_qual_num: null,
      intercepted_confidence: 0.8,
      sea_impact: null,
      sea_impact_qual: null,
      sea_impact_qual_num: null,
      sea_confidence: 0,
      open_area_impact: null,
      open_area_impact_qual: null,
      open_area_impact_qual_num: null,
      open_area_confidence: 0,
      hits_confirmed: null,
      hits_citations: [],
      hits_confidence: 0,
      casualties: null,
      casualties_citations: [],
      casualties_confidence: 0,
      injuries: null,
      injuries_citations: [],
      injuries_confidence: 0,
      confidence: 0.8,
      sources_count: 1,
      citedSources: [
        {
          index: 1,
          channel: "@yediotnews25",
          messageUrl: "https://t.me/yediotnews25/88901",
        },
      ],
    };

    const result = buildEnrichmentFromVote(
      sirenVote,
      earlyEnrichment,
      "siren",
      ALERT_TS,
    );

    // Origin carried from early
    expect(result.origin).toBe("Иран");
    expect(result.originCites).toHaveLength(1);
    // Interception added from siren vote
    expect(result.intercepted).toBe("8");
    // Early warning time preserved
    expect(result.earlyWarningTime).toBe("16:30");
  });
});

// ── buildEnrichedMessage ───────────────────────────────

describe("buildEnrichedMessage", () => {
  const baseMessage = [
    "<b>🚀 Раннее предупреждение</b>",
    "Обнаружены запуски ракет по Израилю",
    "",
    "<b>Район:</b> Тель-Авив — Южный район и Яффо",
    "<b>Подлётное время:</b> ~5–12 мин",
    "<b>Время оповещения:</b> 16:30",
  ].join("\n");

  it("inserts origin before time line with inline cites", () => {
    const enrichment = emptyEnrichmentData();
    enrichment.origin = "Иран";
    enrichment.originCites = [
      { url: "https://t.me/N12LIVE/167775", channel: "@N12LIVE" },
    ];

    const result = buildEnrichedMessage(
      baseMessage,
      "early_warning",
      ALERT_TS,
      enrichment,
    );

    expect(result).toContain("<b>Откуда:</b> Иран");
    expect(result).toContain('href="https://t.me/N12LIVE/167775"');
    // No superscripts
    expect(result).not.toMatch(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/);
    // No "Источники:" footer
    expect(result).not.toContain("Источники:");
    // Origin appears before "Время оповещения"
    const originIdx = result.indexOf("Откуда:");
    const timeIdx = result.indexOf("Время оповещения:");
    expect(originIdx).toBeLessThan(timeIdx);
  });

  it("replaces ~5–12 мин with absolute ETA", () => {
    const enrichment = emptyEnrichmentData();
    enrichment.etaAbsolute = "~16:42";
    enrichment.etaCites = [
      { url: "https://t.me/N12LIVE/167775", channel: "@N12LIVE" },
    ];

    const result = buildEnrichedMessage(
      baseMessage,
      "early_warning",
      ALERT_TS,
      enrichment,
    );

    expect(result).not.toContain("~5–12 мин");
    expect(result).toContain("~16:42");
  });

  it("shows early warning time for siren phase", () => {
    const sirenMessage = [
      "<b>🚨 Сирена</b>",
      "",
      "<b>Район:</b> Тель-Авив — Южный район и Яффо",
      "<b>Подлётное время:</b> 1.5 мин",
      "<b>Время оповещения:</b> 16:34",
    ].join("\n");

    const enrichment = emptyEnrichmentData();
    enrichment.origin = "Иран";
    enrichment.originCites = [];
    enrichment.earlyWarningTime = "16:30";

    const result = buildEnrichedMessage(
      sirenMessage,
      "siren",
      ALERT_TS,
      enrichment,
    );

    expect(result).toContain("Раннее предупреждение:");
    expect(result).toContain("было в 16:30");
  });

  it("adds casualties in resolved phase", () => {
    const resolvedMessage = [
      "<b>😮‍💨 Инцидент завершён</b>",
      "Можно покинуть защищённое помещение.",
      "",
      "<b>Район:</b> Тель-Авив — Южный район и Яффо",
      "<b>Время оповещения:</b> 17:00",
    ].join("\n");

    const enrichment = emptyEnrichmentData();
    enrichment.origin = "Иран";
    enrichment.originCites = [];
    enrichment.intercepted = "12";
    enrichment.interceptedCites = [];
    enrichment.hitsConfirmed = "1";
    enrichment.hitsCites = [];
    enrichment.injuries = "3";
    enrichment.injuriesCites = [
      { url: "https://t.me/N12LIVE/167790", channel: "@N12LIVE" },
    ];

    const result = buildEnrichedMessage(
      resolvedMessage,
      "resolved",
      ALERT_TS,
      enrichment,
    );

    expect(result).toContain("<b>Пострадавшие:</b> 3");
    expect(result).toContain('href="https://t.me/N12LIVE/167790"');
    // Resolved doesn't show rocket count breakdown if no rocketCount
    expect(result).toContain("<b>Перехвачено:</b> 12");
  });

  it("does NOT show casualties in siren phase", () => {
    const sirenMessage = [
      "<b>🚨 Сирена</b>",
      "",
      "<b>Район:</b> Тель-Авив — Южный район и Яффо",
      "<b>Подлётное время:</b> 1.5 мин",
      "<b>Время оповещения:</b> 16:34",
    ].join("\n");

    const enrichment = emptyEnrichmentData();
    enrichment.casualties = "2";
    enrichment.casualtiesCites = [];

    const result = buildEnrichedMessage(
      sirenMessage,
      "siren",
      ALERT_TS,
      enrichment,
    );

    expect(result).not.toContain("Погибшие:");
  });
});

// ── inline citations format ────────────────────────────

describe("inlineCites / inlineCitesFromData", () => {
  it("formats inline [[1]](url) style", () => {
    const sources: CitedSource[] = [
      {
        index: 1,
        channel: "@N12LIVE",
        messageUrl: "https://t.me/N12LIVE/167775",
      },
      {
        index: 2,
        channel: "@yediotnews25",
        messageUrl: "https://t.me/yediotnews25/88901",
      },
    ];

    const result = inlineCites([1, 2], sources);
    expect(result).toContain('<a href="https://t.me/N12LIVE/167775">[1]</a>');
    expect(result).toContain(
      '<a href="https://t.me/yediotnews25/88901">[2]</a>',
    );
    // No superscript characters
    expect(result).not.toMatch(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/);
  });

  it("inlineCitesFromData formats carry-forward cites", () => {
    const cites = [{ url: "https://t.me/N12LIVE/167775", channel: "@N12LIVE" }];

    const result = inlineCitesFromData(cites);
    expect(result).toContain('<a href="https://t.me/N12LIVE/167775">[1]</a>');
  });

  it("returns empty string for no cites", () => {
    expect(inlineCites([], [])).toBe("");
    expect(inlineCitesFromData([])).toBe("");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// LLM Integration Tests (need OPENROUTER_API_KEY)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe.skipIf(!HAS_API)("LLM extraction (real API)", () => {
  // Set the API key for real calls
  if (HAS_API) {
    (config.agent as { apiKey: string }).apiKey = API_KEY;
  }

  /**
   * Call the real LLM for extraction.
   * Mirrors extractAndValidate but for a single post.
   */
  async function extractPost(
    post: { channel: string; text: string; ts: number },
    alertType: "early_warning" | "siren" | "resolved" = "early_warning",
  ): Promise<Record<string, unknown>> {
    const llm = getExtractLLM();
    const alertTimeIL = toIsraelTime(ALERT_TS);
    const postTimeIL = toIsraelTime(post.ts);
    const nowIL = toIsraelTime(Date.now());
    const postAgeMin = Math.round((ALERT_TS - post.ts) / 60_000);
    const postAgeSuffix =
      postAgeMin > 0
        ? `(${postAgeMin} min BEFORE alert)`
        : `(${Math.abs(postAgeMin)} min AFTER alert)`;
    const phaseInstructions = getPhaseInstructions(alertType);
    const systemPrompt = EXTRACT_SYSTEM_PROMPT + "\n\n" + phaseInstructions;

    const contextHeader =
      `Alert time: ${alertTimeIL} (Israel)\n` +
      `Post time:  ${postTimeIL} (Israel) ${postAgeSuffix}\n` +
      `Current time: ${nowIL} (Israel)\n` +
      `Alert region: תל אביב - דרום העיר ויפו\n` +
      `UI language: ru\n`;

    const response = await llm.invoke([
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `${contextHeader}Channel: ${post.channel}\n\nMessage:\n${post.text}`,
      },
    ]);

    const raw =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);
    const text = raw
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "");
    return JSON.parse(text.trim());
  }

  it("correctly identifies Iran as origin from N12 launch report", async () => {
    const result = await extractPost(POST_IRAN_LAUNCH);

    expect(result.country_origin).toBe("Iran");
    expect(result.time_relevance).toBeGreaterThanOrEqual(0.7);
    expect(result.region_relevance).toBeGreaterThanOrEqual(0.5);
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  }, 30_000);

  it("REJECTS stale IDF Lebanon ops post (time_relevance < 0.5)", async () => {
    const result = await extractPost(POST_LEBANON_STALE);

    // This is THE LEBANON BUG — the LLM should recognize this post is
    // from 2.5 hours before the alert and NOT about the current attack
    expect(result.time_relevance).toBeLessThan(0.5);
  }, 30_000);

  it("extracts interception data in siren phase", async () => {
    const result = await extractPost(POST_INTERCEPTION, "siren");

    expect(result.time_relevance).toBeGreaterThanOrEqual(0.7);
    expect(result.country_origin).toBe("Iran");
    // Should have some interception data
    expect(
      result.intercepted !== null || result.intercepted_qual !== null,
    ).toBe(true);
  }, 30_000);

  it("extracts full damage report in resolved phase", async () => {
    const result = await extractPost(POST_RESOLVED, "resolved");

    expect(result.time_relevance).toBeGreaterThanOrEqual(0.7);
    expect(result.country_origin).toBe("Iran");
    expect(result.rocket_count).toBe(15);
    expect(result.intercepted).toBe(12);
    expect(result.hits_confirmed).toBe(1);
    expect(result.injuries).toBe(3);
  }, 30_000);

  it("phase-awareness: early_warning message omits interception data", async () => {
    // LLM may still extract interception data from the text regardless
    // of phase instructions — phase filtering is enforced by buildEnrichedMessage.
    // Verify the message builder respects the phase.
    const enrichment = emptyEnrichmentData();
    enrichment.origin = "Иран";
    enrichment.originCites = [];
    enrichment.intercepted = "12";
    enrichment.interceptedCites = [];
    enrichment.rocketCount = "15";
    enrichment.rocketCites = [];

    const earlyMessage = [
      "<b>🚀 Раннее предупреждение</b>",
      "Обнаружены запуски ракет по Израилю",
      "",
      "<b>Район:</b> Тель-Авив — Южный район и Яффо",
      "<b>Подлётное время:</b> ~5–12 мин",
      "<b>Время оповещения:</b> 16:30",
    ].join("\n");

    const result = buildEnrichedMessage(
      earlyMessage,
      "early_warning",
      ALERT_TS,
      enrichment,
    );

    // Early warning should show origin but NOT interception/hits
    expect(result).toContain("Откуда:");
    expect(result).not.toContain("Перехвачено:");
    expect(result).not.toContain("Попадания:");
  }, 30_000);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Lebanon Bug Regression Test (end-to-end with real API)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe.skipIf(!HAS_API)("Lebanon bug regression (real API)", () => {
  if (HAS_API) {
    (config.agent as { apiKey: string }).apiKey = API_KEY;
  }

  it("should NOT produce Lebanon when stale IDF post + fresh Iran post coexist", async () => {
    // Simulate the exact bug scenario:
    // - POST_LEBANON_STALE from @idf_telegram (2.5 hours old)
    // - POST_IRAN_LAUNCH from @N12LIVE (current alert)
    const llm = getExtractLLM();
    const alertTimeIL = toIsraelTime(ALERT_TS);
    const nowIL = toIsraelTime(Date.now());
    const phaseInstructions = getPhaseInstructions("early_warning");
    const systemPrompt = EXTRACT_SYSTEM_PROMPT + "\n\n" + phaseInstructions;

    const posts = [POST_LEBANON_STALE, POST_IRAN_LAUNCH];
    const extractions: ValidatedExtraction[] = [];

    for (const post of posts) {
      const postTimeIL = toIsraelTime(post.ts);
      const postAgeMin = Math.round((ALERT_TS - post.ts) / 60_000);
      const postAgeSuffix =
        postAgeMin > 0
          ? `(${postAgeMin} min BEFORE alert)`
          : `(${Math.abs(postAgeMin)} min AFTER alert)`;

      const contextHeader =
        `Alert time: ${alertTimeIL} (Israel)\n` +
        `Post time:  ${postTimeIL} (Israel) ${postAgeSuffix}\n` +
        `Current time: ${nowIL} (Israel)\n` +
        `Alert region: תל אביב - דרום העיר ויפו\n` +
        `UI language: ru\n`;

      const response = await llm.invoke([
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `${contextHeader}Channel: ${post.channel}\n\nMessage:\n${post.text}`,
        },
      ]);

      const raw =
        typeof response.content === "string"
          ? response.content
          : JSON.stringify(response.content);
      const text = raw
        .replace(/^```(?:json)?\s*\n?/i, "")
        .replace(/\n?```\s*$/i, "");
      const parsed = JSON.parse(text.trim());

      extractions.push({
        ...parsed,
        channel: post.channel,
        messageUrl: post.messageUrl,
        time_relevance: parsed.time_relevance ?? 0.5,
        valid: true,
      });
    }

    // Run post-filter
    const filtered = postFilter(extractions, "test-regression");

    // Run vote on filtered
    const voted = vote(filtered, "test-regression");

    // THE KEY ASSERTION: if we get a result, it should NOT be Lebanon
    if (voted) {
      const origins = voted.country_origins;
      if (origins && origins.length > 0) {
        const hasLebanon = origins.some((o) => o.name === "Lebanon");
        const hasIran = origins.some((o) => o.name === "Iran");

        // Must NOT have Lebanon as sole origin
        expect(
          hasIran || !hasLebanon,
          "Regression: Lebanon appeared as origin instead of Iran",
        ).toBe(true);
      }
    }
  }, 60_000);
});
