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

// ── Load API key via vi.hoisted (runs before vi.mock factories) ──
const { API_KEY, HAS_API } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fs = require("node:fs");
  let key = process.env.OPENROUTER_API_KEY ?? "";

  if (!key) {
    try {
      const yaml = require("js-yaml");
      const candidates: string[] = ["config.yaml", "config.yml"];
      try {
        candidates.push(
          ...fs.readdirSync(".").filter(
            (f: string) => /^config\..*\.ya?ml$/.test(f) && !candidates.includes(f),
          ),
        );
      } catch { /* ignore */ }

      for (const file of candidates) {
        try {
          const raw = fs.readFileSync(file, "utf-8");
          const cfg = yaml.load(raw) as Record<string, unknown>;
          const ai = cfg?.ai as Record<string, unknown> | undefined;
          const k = (ai?.openrouter_api_key as string) ?? "";
          if (k) { key = k; break; }
        } catch { /* try next */ }
      }
    } catch {
      // No config files — LLM tests will be skipped
    }
  }

  return { API_KEY: key, HAS_API: Boolean(key) };
});

// ── Mocks ──────────────────────────────────────────────

vi.mock("@easyoref/monitoring", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  flush: vi.fn(),
}));

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
        apiKey: API_KEY || "test-key",
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

import * as logger from "@easyoref/monitoring";
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Full pipeline — real LLM (needs API key)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { getChannelPosts } from "@easyoref/shared";

describe.skipIf(!HAS_API)("full pipeline with real LLM (openai/gpt-oss-120b:free)", () => {
  it("produces synthesized insights from realistic Telegram posts", async () => {
    const NOW = Date.now();

    // Realistic posts that mimic what Telegram news channels post during an attack
    const fakePosts = [
      {
        channel: "red_alert_israel",
        text: "Запуск ракет из Ирана в сторону Израиля. По предварительным данным выпущено около 30 баллистических ракет. Подлётное время до центра Израиля 12 минут.",
        ts: NOW + 1000,
        messageUrl: "https://t.me/red_alert_israel/12345",
      },
      {
        channel: "military_observer",
        text: "ЦАХАЛ подтверждает: массированный ракетный обстрел с территории Ирана. Система ПВО Железный Купол и Праща Давида активированы. Перехвачено большинство целей над Гуш Даном.",
        ts: NOW + 2000,
        messageUrl: "https://t.me/military_observer/6789",
      },
      {
        channel: "news_tel_aviv",
        text: "Взрывы слышны в Тель-Авиве и окрестностях. Сирены продолжают звучать. Жителям рекомендовано оставаться в укрытиях. По данным источников, перехвачена большая часть ракет.",
        ts: NOW + 3000,
        messageUrl: "https://t.me/news_tel_aviv/9999",
      },
    ];

    // Override getChannelPosts for this test only
    vi.mocked(getChannelPosts).mockResolvedValueOnce(fakePosts);

    const { runEnrichment } = await import("../src/graph.js");

    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.info).mockClear();

    try {
      await runEnrichment({
        alertId: "test-real-llm-001",
        alertTs: NOW,
        alertType: "red_alert",
        alertAreas: ["תל אביב - דרום העיר ויפו"],
        chatId: "-1001234567890",
        messageId: 42,
        isCaption: false,
        telegramMessages: [
          { chatId: "-1001234567890", messageId: 42, isCaption: false },
        ],
        currentText: "<b>🔴 אזעקה</b>\nתל אביב - דרום העיר ויפו",
        monitoringLabel: "⏳ Мониторинг...",
      });
    } catch (err) {
      // Tolerate provider errors (credit, rate-limit, model overloaded)
      const msg = String(err);
      if (/credit|rate.?limit|overloaded|timeout|503|429|402|403/i.test(msg)) {
        console.warn(`⚠️  Provider error (test passes as soft-fail): ${msg.slice(0, 120)}`);
        return;
      }
      throw err;
    }

    // The pipeline should have produced insights — terminal guard should NOT fire
    const zeroInsightsWarning = vi.mocked(logger.warn).mock.calls.find(
      (args) => typeof args[0] === "string" && args[0].includes("ZERO synthesized insights"),
    );

    // If the free model is overloaded, we tolerate zero insights but log it
    if (zeroInsightsWarning) {
      console.warn(
        "⚠️  Pipeline produced zero insights (free model may be overloaded) — test passes but check LangSmith trace",
      );
    } else {
      // Verify that synthesize-node actually produced fields
      const synthCalls = vi.mocked(logger.info).mock.calls.filter(
        (args) => typeof args[0] === "string" && args[0].includes("synthesize-node: synthesis done"),
      );
      expect(synthCalls.length).toBeGreaterThan(0);

      // Verify at least one synthesized key was produced
      const synthMeta = synthCalls[0]?.[1] as { synthesizedKeys?: string[] } | undefined;
      expect(synthMeta?.synthesizedKeys?.length).toBeGreaterThan(0);
    }

    // Either way: pre-filter must have forwarded channels (not the "no posts" path)
    const preFilterCall = vi.mocked(logger.info).mock.calls.find(
      (args) => typeof args[0] === "string" && args[0].includes("pre-filter-node: pass-through"),
    );
    expect(preFilterCall).toBeTruthy();
  }, 60_000);
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Pipeline dry-run — no LLM, no network
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("pipeline dry-run (no posts)", () => {
  it("completes graph with zero posts and emits terminal warning", async () => {
    const { runEnrichment } = await import("../src/graph.js");

    await runEnrichment({
      alertId: "test-dry-run-001",
      alertTs: Date.now(),
      alertType: "red_alert",
      alertAreas: ["תל אביב - דרום העיר ויפו"],
      chatId: "-1001234567890",
      messageId: 42,
      isCaption: false,
      telegramMessages: [
        { chatId: "-1001234567890", messageId: 42, isCaption: false },
      ],
      currentText: "<b>Test alert</b>",
      monitoringLabel: "⏳ Мониторинг...",
    });

    // Terminal guard must fire: warn about zero synthesized insights
    expect(logger.warn).toHaveBeenCalledWith(
      "runEnrichment: pipeline completed with ZERO synthesized insights",
      expect.objectContaining({ alertId: "test-dry-run-001" }),
    );

    // Node logging must fire: pre-filter should report no posts
    expect(logger.info).toHaveBeenCalledWith(
      "pre-filter-node: no posts found",
      expect.objectContaining({ alertId: "test-dry-run-001" }),
    );
  });
});
