/**
 * Integration tests for the enrichment pipeline.
 *
 * Two sections:
 *   1. Deterministic tests (no API): textHash, toIsraelTime, buildEnrichedMessage
 *   2. LLM tests (need OPENROUTER_API_KEY): real resolveArea tier-3 LLM fallback
 *
 * API key is read from config.yaml (ai.openrouter_api_key) if not in env.
 */

import { textHash, toIsraelTime } from "@easyoref/shared";
import { describe, expect, it, vi } from "vitest";

// ── Load API key from config.yaml ──────────────────────

let API_KEY = process.env.OPENROUTER_API_KEY ?? "";

if (!API_KEY) {
  try {
    const { readFileSync } = await import("node:fs");
    const { load } = await import("js-yaml");
    const raw = readFileSync("config.yaml", "utf-8");
    const cfg = load(raw) as Record<string, unknown>;
    const ai = cfg?.ai as Record<string, unknown> | undefined;
    API_KEY = (ai?.openrouter_api_key as string) ?? "";
  } catch {
    // No config.yaml — LLM tests will be skipped
  }
}

const HAS_API = Boolean(API_KEY);

// ── Mocks ──────────────────────────────────────────────

vi.mock("@easyoref/shared", async () => {
  const actual = await vi.importActual("@easyoref/shared");
  return {
    ...actual,
    config: {
      agent: {
        filterModel: "openai/gpt-oss-120b:free",
        filterFallbackModel: "openai/gpt-oss-120b:free",
        extractModel: "openai/gpt-oss-120b:free",
        extractFallbackModel: "openai/gpt-oss-120b:free",
        apiKey: process.env.OPENROUTER_API_KEY || "test-key",
        mcpTools: false,
        confidenceThreshold: 0.65,
        enrichDelayMs: 20_000,
        windowMinutes: 2,
        timeoutMinutes: 15,
        areaLabels: {},
        clarifyFetchCount: 3,
        channels: [],
      },
      areas: ["תל אביב - דרום העיר ויפו"],
      language: "ru",
      botToken: "",
      chatId: "",
      orefApiUrl: "",
      orefHistoryUrl: "",
      logtailToken: "",
    },
    getRedis: vi.fn().mockReturnValue({
      get: vi.fn().mockResolvedValue(undefined),
      setex: vi.fn(),
      lpush: vi.fn(),
      expire: vi.fn(),
      lrange: vi.fn().mockResolvedValue([]),
      del: vi.fn(),
    }),
    getChannelPosts: vi.fn().mockResolvedValue([]),
    getEnrichment: vi.fn().mockResolvedValue(undefined),
    getActiveSession: vi.fn().mockResolvedValue(undefined),
    saveEnrichment: vi.fn(),
    pushSessionPost: vi.fn(),
    getCachedExtractions: vi.fn().mockResolvedValue(new Map()),
    saveCachedExtractions: vi.fn(),
    getLastUpdateTs: vi.fn().mockResolvedValue(0),
    setLastUpdateTs: vi.fn(),
  };
});

// ── Imports (after mocks) ──────────────────────────────

import {
  buildEnrichedMessage,
  insertBeforeBlockEnd,
  stripMonitoring,
} from "../src/utils/message.js";
import { resolveArea } from "../src/tools/resolve-area.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Deterministic tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const ALERT_TS = Date.parse("2026-03-09T14:30:00.000Z");

describe("toIsraelTime", () => {
  it("formats UTC timestamp to Israel time HH:MM", () => {
    const formatted = toIsraelTime(ALERT_TS);
    expect(formatted).toMatch(/^\d{2}:\d{2}$/);
  });

  it("is UTC+2 offset in winter (January)", () => {
    const ts = new Date("2024-01-15T12:00:00Z").getTime();
    expect(toIsraelTime(ts)).toMatch(/14:00/);
  });
});

describe("textHash", () => {
  it("returns consistent hash", () => {
    const h1 = textHash("hello");
    const h2 = textHash("hello");
    const h3 = textHash("world");
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });

  it("produces hex string", () => {
    expect(textHash("test")).toMatch(/^[a-f0-9]+$/);
  });
});

describe("insertBeforeBlockEnd", () => {
  it("inserts before </blockquote>", () => {
    const text = "<blockquote>Content\n</blockquote>";
    const result = insertBeforeBlockEnd(text, "NEW");
    expect(result.indexOf("NEW")).toBeLessThan(result.indexOf("</blockquote>"));
  });

  it("inserts before Время оповещения when no blockquote", () => {
    const text = "Line\n<b>Время оповещения:</b> 18:00";
    const result = insertBeforeBlockEnd(text, "NEW");
    expect(result.indexOf("NEW")).toBeLessThan(result.indexOf("Время оповещения:"));
  });
});

describe("stripMonitoring", () => {
  it("removes monitoring emoji line", () => {
    const text = 'Text\n<tg-emoji emoji-id="1">⏳</tg-emoji> Мониторинг...';
    expect(stripMonitoring(text)).toBe("Text");
  });
});

describe("buildEnrichedMessage", () => {
  const baseMsg = [
    "<b>🚀 Раннее предупреждение</b>",
    "Обнаружены запуски",
    "",
    "<b>Район:</b> Тель-Авив — Южный",
    "<b>Подлётное время:</b> ~5–12 мин",
    "<b>Время оповещения:</b> 16:30",
  ].join("\n");

  it("inserts origin before time line", () => {
    const insights = [
      { key: "origin", value: "Иран", confidence: 0.9, sourceUrls: [] },
    ];
    const result = buildEnrichedMessage(baseMsg, "early_warning", ALERT_TS, insights);
    expect(result).toContain("<b>Откуда:</b> Иран");
    expect(result.indexOf("Откуда:")).toBeLessThan(result.indexOf("Время оповещения:"));
  });

  it("replaces ETA range with absolute time in early_warning", () => {
    const insights = [
      { key: "eta_absolute", value: "~16:42", confidence: 0.85, sourceUrls: [] },
    ];
    const result = buildEnrichedMessage(baseMsg, "early_warning", ALERT_TS, insights);
    expect(result).not.toContain("~5–12 мин");
    expect(result).toContain("~16:42");
  });

  it("intercepted visible in red_alert, hidden in early_warning", () => {
    const insights = [
      { key: "intercepted", value: "12", confidence: 0.9, sourceUrls: [] },
    ];
    const siren = buildEnrichedMessage(baseMsg, "red_alert", ALERT_TS, insights);
    const early = buildEnrichedMessage(baseMsg, "early_warning", ALERT_TS, insights);
    expect(siren).toContain("<b>Перехваты:</b> 12");
    expect(early).not.toContain("Перехваты:");
  });

  it("casualties only in resolved phase", () => {
    const resolvedMsg = [
      "<b>😮‍💨 Инцидент завершён</b>",
      "<b>Район:</b> Тель-Авив — Южный",
      "<b>Время оповещения:</b> 17:00",
    ].join("\n");
    const insights = [
      { key: "casualties", value: "2 погибших", confidence: 0.95, sourceUrls: [] },
    ];
    const resolved = buildEnrichedMessage(resolvedMsg, "resolved", ALERT_TS, insights);
    const siren = buildEnrichedMessage(resolvedMsg, "red_alert", ALERT_TS, insights);
    expect(resolved).toContain("<b>Погибшие:</b> 2 погибших");
    expect(siren).not.toContain("Погибшие:");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// resolveArea — deterministic tiers (no LLM)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("resolveArea (deterministic)", () => {
  const userAreas = ["תל אביב - דרום העיר ויפו", "הרצליה"];

  it("exact match returns tier=exact and relevant=true", async () => {
    const result = await resolveArea("תל אביב - דרום העיר ויפו", userAreas);
    expect(result.relevant).toBe(true);
    expect(result.tier).toBe("exact");
  });

  it("substring match returns relevant=true", async () => {
    const result = await resolveArea("הרצליה", userAreas);
    expect(result.relevant).toBe(true);
  });

  it("ZONE_HIERARCHY macro region returns tier=hierarchy and relevant=true for Tel Aviv", async () => {
    // גוש דן is the area in ZONE_HIERARCHY that contains Tel Aviv zones
    const result = await resolveArea("גוש דן", userAreas);
    expect(result.relevant).toBe(true);
    expect(result.tier).toBe("hierarchy");
  });

  it("unrelated city returns relevant=false", async () => {
    // London is geographically unambiguous — no capable LLM should say it contains Tel Aviv
    const result = await resolveArea("London", userAreas);
    expect(result.relevant).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// resolveArea — LLM tier-3 (needs API key)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe.skipIf(!HAS_API)("resolveArea LLM tier-3 (real API)", () => {
  it("resolves מרכז (Center) as relevant macro region for Tel Aviv", async () => {
    // "מרכז" (Center) is not in ZONE_HIERARCHY but LLM should know Tel Aviv is in Center
    const result = await resolveArea("מרכז", ["תל אביב - דרום העיר ויפו"]);
    expect(result.relevant).toBe(true);
  }, 30_000);

  it("resolves צפון (North) as not relevant for Tel Aviv", async () => {
    // North region doesn't contain Tel Aviv
    const result = await resolveArea("צפון", ["תל אביב - דרום העיר ויפו"]);
    expect(result.relevant).toBe(false);
  }, 30_000);
});
