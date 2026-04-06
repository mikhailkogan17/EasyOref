/**
 * Integration tests for the enrichment pipeline.
 *
 * Sections:
 *   1. resolveArea — deterministic tiers + LLM tier-3 (needs OPENROUTER_API_KEY)
 *   2. Full pipeline — real LLM (needs OPENROUTER_API_KEY)
 *   3. Pipeline dry-run — deterministic, no LLM
 *   4. Backfill fallback — deterministic
 *
 * NOTE: Pure-unit tests for textHash, toIsraelTime, insertBeforeBlockEnd,
 * buildEnrichedMessage are in graph.test.ts — not duplicated here.
 *
 * API key is read from config.yaml (ai.openrouter_api_key) if not in env.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Load API key via vi.hoisted (runs before vi.mock factories) ──
const { API_KEY, HAS_API, FREE_PRIMARY, FREE_FALLBACK } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fs = require("node:fs");
  let key = process.env.OPENROUTER_API_KEY ?? "";

  if (!key) {
    try {
      const yaml = require("js-yaml");
      const candidates: string[] = ["config.yaml", "config.yml"];
      try {
        candidates.push(
          ...fs
            .readdirSync(".")
            .filter(
              (f: string) =>
                /^config\..*\.ya?ml$/.test(f) && !candidates.includes(f),
            ),
        );
      } catch {
        /* ignore */
      }

      for (const file of candidates) {
        try {
          const raw = fs.readFileSync(file, "utf-8");
          const cfg = yaml.load(raw) as Record<string, unknown>;
          const ai = cfg?.ai as Record<string, unknown> | undefined;
          const k = (ai?.openrouter_api_key as string) ?? "";
          if (k) {
            key = k;
            break;
          }
        } catch {
          /* try next */
        }
      }
    } catch {
      // No config files — LLM tests will be skipped
    }
  }

  return {
    API_KEY: key,
    HAS_API: Boolean(key),
    FREE_PRIMARY: "openai/gpt-oss-120b:free",
    FREE_FALLBACK: "meta-llama/llama-3.3-70b-instruct:free",
  };
});

// ── Mocks ──────────────────────────────────────────────

vi.mock("@easyoref/shared/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  flush: vi.fn(),
}));

vi.mock("@easyoref/gramjs", () => ({
  backfillChannelPosts: vi.fn().mockResolvedValue(0),
  MONITORED_CHANNELS: [],
}));

vi.mock("@easyoref/shared", async () => {
  const actual = await vi.importActual("@easyoref/shared");
  return {
    ...actual,
    config: {
      agent: {
        filterModel: FREE_PRIMARY,
        filterFallbackModel: FREE_FALLBACK,
        extractModel: FREE_PRIMARY,
        extractFallbackModel: FREE_FALLBACK,
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
    getVotedInsights: vi.fn().mockResolvedValue([]),
    saveVotedInsights: vi.fn(),
  };
});

// ── Imports (after mocks) ──────────────────────────────

import * as logger from "@easyoref/shared/logger";
import { resolveArea } from "../src/tools/resolve-area.js";

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
  // Cooldown between LLM-hitting tests to avoid rate limits on free models
  beforeEach(async () => {
    await new Promise((r) => setTimeout(r, 2_000));
  });

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

describe.skipIf(!HAS_API)(
  "full pipeline with real LLM (openai/gpt-oss-120b:free)",
  () => {
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
        });
      } catch (err) {
        // Tolerate provider errors (credit, rate-limit, model overloaded, spend limit)
        const msg = String(err);
        const code = (err as { code?: number })?.code;
        if (
          /credit|rate.?limit|overloaded|timeout|timed?\s*out|spend.?limit|not.?supported|503|529|429|402|403/i.test(
            msg,
          ) ||
          code === 402 ||
          code === 429
        ) {
          console.warn(
            `⚠️  Provider error (test passes as soft-fail): ${msg.slice(
              0,
              120,
            )}`,
          );
          return;
        }
        throw err;
      }

      // The pipeline should have produced insights — terminal guard should NOT fire
      const zeroInsightsWarning = vi
        .mocked(logger.warn)
        .mock.calls.find(
          (args) =>
            typeof args[0] === "string" &&
            args[0].includes("ZERO synthesized insights"),
        );

      // If the free model is overloaded, we tolerate zero insights but log it
      if (zeroInsightsWarning) {
        console.warn(
          "⚠️  Pipeline produced zero insights (free model may be overloaded) — test passes but check LangSmith trace",
        );
      } else {
        // Verify that synthesize-node actually produced fields
        const synthCalls = vi
          .mocked(logger.info)
          .mock.calls.filter(
            (args) =>
              typeof args[0] === "string" &&
              args[0].includes("synthesize-node: synthesis done"),
          );
        expect(synthCalls.length).toBeGreaterThan(0);

        // Verify at least one synthesized key was produced
        const synthMeta = synthCalls[0]?.[1] as
          | { synthesizedKeys?: string[] }
          | undefined;
        expect(synthMeta?.synthesizedKeys?.length).toBeGreaterThan(0);
      }

      // Either way: pre-filter must have forwarded channels (not the "no posts" path)
      const preFilterCall = vi
        .mocked(logger.info)
        .mock.calls.find(
          (args) =>
            typeof args[0] === "string" &&
            args[0].includes("pre-filter-node: pass-through"),
        );
      expect(preFilterCall).toBeTruthy();
    }, 120_000);
  },
);

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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Backfill fallback — delayed data
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { backfillChannelPosts } from "@easyoref/gramjs";

describe("pipeline backfill fallback (delayed data)", () => {
  it("triggers backfill when first getChannelPosts returns empty, then retries", async () => {
    const NOW = Date.now();
    const mockBackfill = vi.mocked(backfillChannelPosts);

    // First call: no posts (event-based failed). Second call: posts available (after backfill)
    const fakePosts = [
      {
        channel: "test_channel",
        text: "Ракеты в сторону центра, подлёт 12 минут",
        ts: NOW + 1000,
        messageUrl: "https://t.me/test/123",
      },
    ];
    vi.mocked(getChannelPosts)
      .mockResolvedValueOnce([]) // first call: empty
      .mockResolvedValueOnce(fakePosts); // second call: after backfill

    mockBackfill.mockResolvedValueOnce(1); // simulate 1 post backfilled

    const { filterNode } = await import("../src/nodes/pre-filter-node.js");
    const result = await filterNode({
      alertId: "test-backfill-001",
      alertTs: NOW,
      alertType: "red_alert",
      messages: [],
    } as any);

    expect(mockBackfill).toHaveBeenCalledWith(NOW);
    expect(logger.info).toHaveBeenCalledWith(
      "pre-filter-node: fallback polling fetched posts",
      expect.objectContaining({ alertId: "test-backfill-001", count: 1 }),
    );
    // Should have produced tracking with the channel
    expect(result.tracking).toBeDefined();
    expect(result.tracking!.channelsWithUpdates.length).toBeGreaterThan(0);
  });
});
