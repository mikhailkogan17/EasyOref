/**
 * Tests for tools and routing logic.
 *
 * Tests:
 *   1. readSourcesTool
 *   2. alertHistoryTool
 *   3. shouldClarify routing (pure logic)
 *   4. contradiction detection (new architecture)
 *   5. clarifyTools export
 *   6. resolveAreaTool
 *   7. formatOrefDate
 *   8. betterstackLogTool
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────

vi.mock("@easyoref/shared", async () => {
  const actual = await vi.importActual("@easyoref/shared");
  return {
    ...actual,
    config: {
      agent: {
        model: "test-model",
        apiKey: "test-key",
        mcpTools: true,
        clarifyFetchCount: 3,
        confidenceThreshold: 0.6,
        filterModel: "google/gemini-2.5-flash-lite",
        filterFallbackModel: "meta-llama/llama-3.3-70b-instruct:free",
        extractModel: "google/gemini-3.1-flash-lite-preview",
        extractFallbackModel: "meta-llama/llama-3.3-70b-instruct:free",
        channels: ["@idf_telegram", "@N12LIVE", "@kann_news"],
        areaLabels: { הרצליה: "Герцлия" },
      },
      botToken: "",
      orefApiUrl: "https://mock.oref.api/alerts",
      orefHistoryUrl: "",
      logtailToken: "test-logtail-token",
      areas: ["הרצליה", "תל אביב - דרום העיר ויפו"],
      language: "ru",
    },
    getRedis: vi.fn().mockReturnValue({
      lpush: vi.fn(),
      expire: vi.fn(),
    }),
    pushSessionPost: vi.fn(),
    pushChannelPost: vi.fn(),
  };
});

vi.mock("@easyoref/shared/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("@easyoref/gramjs", () => ({
  fetchRecentChannelPosts: vi.fn(),
}));

// ═════════════════════════════════════════════════════════
// 1. readSourcesTool
// ═════════════════════════════════════════════════════════

describe("readSourcesTool", () => {
  let readSourcesTool: typeof import("../src/tools/index.js").readSourcesTool;
  let fetchRecentChannelPosts: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const toolsMod = await import("../src/tools/index.js");
    readSourcesTool = toolsMod.readSourcesTool;
    const gramjsMod = await import("@easyoref/gramjs");
    fetchRecentChannelPosts = gramjsMod.fetchRecentChannelPosts as ReturnType<typeof vi.fn>;
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns posts from channel", async () => {
    fetchRecentChannelPosts.mockResolvedValueOnce([
      { text: "IDF reports 12 rockets launched", ts: 1700000000, messageUrl: "https://t.me/idf/100" },
      { text: "Iron Dome intercepted majority", ts: 1700000001, messageUrl: "https://t.me/idf/101" },
    ]);

    const result = await readSourcesTool.invoke({ channel: "@idf_telegram", limit: 3 });
    const parsed = JSON.parse(result);
    expect(parsed.channel).toBe("@idf_telegram");
    expect(parsed.posts).toHaveLength(2);
    expect(parsed.posts[0].text).toContain("12 rockets");
    expect(parsed.count).toBe(2);
    expect(fetchRecentChannelPosts).toHaveBeenCalledWith("@idf_telegram", 3);
  });

  it("limits posts to clarifyFetchCount", async () => {
    fetchRecentChannelPosts.mockResolvedValueOnce([{ text: "Post1", ts: 1, messageUrl: undefined }]);
    await readSourcesTool.invoke({ channel: "@test", limit: 4 });
    expect(fetchRecentChannelPosts).toHaveBeenCalledWith("@test", 3);
  });

  it("truncates long texts to 800 chars", async () => {
    const longText = "A".repeat(1500);
    fetchRecentChannelPosts.mockResolvedValueOnce([{ text: longText, ts: 1, messageUrl: undefined }]);
    const result = await readSourcesTool.invoke({ channel: "@test", limit: 1 });
    const parsed = JSON.parse(result);
    expect(parsed.posts[0].text.length).toBe(800);
  });

  it("returns empty array when no posts", async () => {
    fetchRecentChannelPosts.mockResolvedValueOnce([]);
    const result = await readSourcesTool.invoke({ channel: "@empty", limit: 2 });
    const parsed = JSON.parse(result);
    expect(parsed.posts).toHaveLength(0);
    expect(parsed.note).toContain("No recent posts");
  });

  it("handles FLOOD error gracefully (retry: false)", async () => {
    fetchRecentChannelPosts.mockRejectedValueOnce(new Error("FLOOD_WAIT_420"));
    const result = await readSourcesTool.invoke({ channel: "@flooded", limit: 1 });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("Failed to fetch");
    expect(parsed.retry).toBe(false);
  });

  it("handles generic error gracefully (retry: true)", async () => {
    fetchRecentChannelPosts.mockRejectedValueOnce(new Error("Network timeout"));
    const result = await readSourcesTool.invoke({ channel: "@broken", limit: 1 });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("Network timeout");
    expect(parsed.retry).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════
// 2. alertHistoryTool
// ═════════════════════════════════════════════════════════

describe("alertHistoryTool", () => {
  let alertHistoryTool: typeof import("../src/tools/index.js").alertHistoryTool;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    vi.resetModules();
    const toolsMod = await import("../src/tools/index.js");
    alertHistoryTool = toolsMod.alertHistoryTool;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns empty when no history", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: true, text: async () => "" });
    const result = await alertHistoryTool.invoke({ area: "תל אביב", last_minutes: 30 });
    const parsed = JSON.parse(result);
    expect(parsed.alerts).toEqual([]);
    expect(parsed.note).toContain("No alert history");
  });

  it("filters history by area", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify([
        { alertDate: "2024-01-15 10:30", title: "ירי רקטות", data: "תל אביב - דרום העיר ויפו", category_desc: "Missiles" },
        { alertDate: "2024-01-15 10:31", title: "ירי רקטות", data: "חיפה - מערב", category_desc: "Missiles" },
      ]),
    });
    const result = await alertHistoryTool.invoke({ area: "תל אביב", last_minutes: 30 });
    const parsed = JSON.parse(result);
    expect(parsed.alerts).toHaveLength(1);
    expect(parsed.total_in_period).toBe(2);
    expect(parsed.relevant_count).toBe(1);
    expect(parsed.alerts[0].date).toBe("2024-01-15 10:30");
  });

  it("handles HTTP error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 });
    const result = await alertHistoryTool.invoke({ area: "test", last_minutes: 30 });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("503");
    expect(parsed.retry).toBe(true);
  });

  it("handles network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error("fetch failed"));
    const result = await alertHistoryTool.invoke({ area: "test", last_minutes: 30 });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("fetch failed");
    expect(parsed.retry).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════
// 3. shouldClarify routing logic (pure, no VotedResult needed)
// ═════════════════════════════════════════════════════════

describe("shouldClarify routing", () => {
  // Inline the pure routing logic
  function shouldClarify(state: {
    clarifyAttempted: boolean;
    mcpToolsEnabled: boolean;
    needsClarify: boolean;
  }): "clarify" | "editMessage" {
    if (state.clarifyAttempted) return "editMessage";
    if (!state.mcpToolsEnabled) return "editMessage";
    if (state.needsClarify) return "clarify";
    return "editMessage";
  }

  it("routes to clarify when needsClarify=true", () => {
    expect(shouldClarify({ clarifyAttempted: false, mcpToolsEnabled: true, needsClarify: true })).toBe("clarify");
  });

  it("routes to editMessage when needsClarify=false", () => {
    expect(shouldClarify({ clarifyAttempted: false, mcpToolsEnabled: true, needsClarify: false })).toBe("editMessage");
  });

  it("routes to editMessage when already clarified", () => {
    expect(shouldClarify({ clarifyAttempted: true, mcpToolsEnabled: true, needsClarify: true })).toBe("editMessage");
  });

  it("routes to editMessage when MCP tools disabled", () => {
    expect(shouldClarify({ clarifyAttempted: false, mcpToolsEnabled: false, needsClarify: true })).toBe("editMessage");
  });
});

// ═════════════════════════════════════════════════════════
// 4. Contradiction detection (new ValidatedInsight architecture)
// ═════════════════════════════════════════════════════════

describe("contradiction detection", () => {
  // Import describeContradictions from utils/contradictions
  let describeContradictions: typeof import("../src/utils/contradictions.js").describeContradictions;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../src/utils/contradictions.js");
    describeContradictions = mod.describeContradictions;
  });

  function makeInsight(kind: "country_origins" | "rocket_count", value: unknown, confidence = 0.8) {
    return {
      kind: { kind, value } as any,
      source: { channelId: "@test", sourceType: "telegram_channel" as const, timestamp: Date.now(), text: "test" },
      timeRelevance: 1,
      regionRelevance: 1,
      confidence,
      timeStamp: new Date().toISOString(),
      isValid: true,
    };
  }

  it("detects multiple country origins", () => {
    const insights = [
      makeInsight("country_origins", new Set(["Lebanon", "Iran"])),
    ];
    const result = describeContradictions(insights as any);
    expect(result).toContain("Multiple origin countries");
  });

  it("detects wide rocket count range", () => {
    const insights = [
      makeInsight("rocket_count", { type: "exact", value: 5 }),
      makeInsight("rocket_count", { type: "exact", value: 20 }),
    ];
    const result = describeContradictions(insights as any);
    expect(result).toContain("Wide rocket count range: 5–20");
  });

  it("does not flag narrow rocket count range", () => {
    const insights = [
      makeInsight("rocket_count", { type: "exact", value: 10 }),
      makeInsight("rocket_count", { type: "exact", value: 12 }),
    ];
    const result = describeContradictions(insights as any);
    expect(result).not.toContain("Wide rocket count range");
  });

  it("flags low confidence insights", () => {
    const insights = [makeInsight("rocket_count", { type: "exact", value: 5 }, 0.3)];
    const result = describeContradictions(insights as any);
    expect(result).toContain("low confidence");
  });

  it("always includes summary stats", () => {
    const insights = [makeInsight("country_origins", new Set(["Iran"]))];
    const result = describeContradictions(insights as any);
    expect(result).toContain("Total valid insights:");
    expect(result).toContain("Insight kinds:");
  });
});

// ═════════════════════════════════════════════════════════
// 5. clarifyTools export
// ═════════════════════════════════════════════════════════

describe("clarifyTools export", () => {
  it("exports exactly 4 tools", async () => {
    const { clarifyTools } = await import("../src/tools/index.js");
    expect(clarifyTools).toHaveLength(4);
  });

  it("has correct tool names", async () => {
    const { clarifyTools } = await import("../src/tools/index.js");
    const names = clarifyTools.map((t) => t.name);
    expect(names).toContain("read_telegram_sources");
    expect(names).toContain("alert_history");
    expect(names).toContain("resolve_area");
    expect(names).toContain("betterstack_log");
  });

  it("does not include old MCP-prefixed tool names", async () => {
    const { clarifyTools } = await import("../src/tools/index.js");
    const names = clarifyTools.map((t) => t.name);
    expect(names).not.toContain("telegram_mtproto_mcp_read_sources");
    expect(names).not.toContain("pikud_haoref_mcp");
  });
});

// ═════════════════════════════════════════════════════════
// 6. resolveAreaTool
// ═════════════════════════════════════════════════════════

describe("resolveAreaTool", () => {
  let resolveAreaTool: typeof import("../src/tools/index.js").resolveAreaTool;

  beforeEach(async () => {
    vi.resetModules();
    const toolsMod = await import("../src/tools/index.js");
    resolveAreaTool = toolsMod.resolveAreaTool;
  });

  afterEach(() => vi.restoreAllMocks());

  it("resolves direct match (הרצליה)", async () => {
    const result = await resolveAreaTool.invoke({ location: "הרצליה" });
    const parsed = JSON.parse(result);
    expect(parsed.relevant).toBe(true);
    expect(parsed.reasoning).toContain("directly matches");
  });

  it("resolves region keyword (מרכז → תל אביב)", async () => {
    const result = await resolveAreaTool.invoke({ location: "מרכז" });
    const parsed = JSON.parse(result);
    expect(parsed.relevant).toBe(true);
  });

  it("rejects unrelated area (קריית שמונה — far north)", async () => {
    const result = await resolveAreaTool.invoke({ location: "קריית שמונה" });
    const parsed = JSON.parse(result);
    expect(parsed.relevant).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════
// 7. resolveArea (unit — 3-tier logic)
// ═════════════════════════════════════════════════════════

describe("resolveArea (unit)", () => {
  let resolveArea: typeof import("../src/tools/resolve-area.js").resolveArea;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../src/tools/resolve-area.js");
    resolveArea = mod.resolveArea;
  });

  const monitored = ["הרצליה", "תל אביב - דרום העיר ויפו"];

  it("tier 1: exact match (הרצליה)", async () => {
    const r = await resolveArea("הרצליה", monitored);
    expect(r.relevant).toBe(true);
    expect(r.tier).toBe("exact");
    expect(r.matchedAreas).toContain("הרצליה");
  });

  it("tier 1: substring match (תל אביב)", async () => {
    const r = await resolveArea("תל אביב", monitored);
    expect(r.relevant).toBe(true);
    expect(r.tier).toBe("exact");
  });

  it("tier 2: hierarchy match (מרכז → includes תל אביב zones)", async () => {
    const r = await resolveArea("מרכז", monitored);
    expect(r.relevant).toBe(true);
    expect(["exact", "hierarchy"]).toContain(r.tier);
  });

  it("tier 2: hierarchy match (גוש דן → includes תל אביב zones)", async () => {
    const r = await resolveArea("גוש דן", monitored);
    expect(r.relevant).toBe(true);
    expect(["exact", "hierarchy"]).toContain(r.tier);
  });

  it("none: unrelated area (קריית שמונה)", async () => {
    const r = await resolveArea("קריית שמונה", monitored);
    expect(r.relevant).toBe(false);
    expect(r.tier).toBe("none");
  });

  it("returns none for empty userAreas", async () => {
    const r = await resolveArea("תל אביב", []);
    expect(r.relevant).toBe(false);
    expect(r.tier).toBe("none");
  });

  it("returns none for empty mentioned", async () => {
    const r = await resolveArea("", monitored);
    expect(r.relevant).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════
// 8. formatOrefDate
// ═════════════════════════════════════════════════════════

describe("formatOrefDate", () => {
  it("formats date as DD.MM.YYYY", async () => {
    const { _formatOrefDate } = await import("../src/tools/index.js");
    const d = new Date("2024-03-09T12:00:00Z");
    expect(_formatOrefDate(d)).toBe("09.03.2024");
  });

  it("pads single digit day and month", async () => {
    const { _formatOrefDate } = await import("../src/tools/index.js");
    const d = new Date("2024-01-05T00:00:00Z");
    expect(_formatOrefDate(d)).toBe("05.01.2024");
  });
});

// ═════════════════════════════════════════════════════════
// 9. betterstackLogTool
// ═════════════════════════════════════════════════════════

describe("betterstackLogTool", () => {
  let betterstackLogTool: typeof import("../src/tools/index.js").betterstackLogTool;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    vi.resetModules();
    const toolsMod = await import("../src/tools/index.js");
    betterstackLogTool = toolsMod.betterstackLogTool;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns log events matching query", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [
          { timestamp: "2024-01-15T10:30:00Z", message: "Alert processed" },
          { timestamp: "2024-01-15T10:29:00Z", message: "Enrichment started" },
        ],
      }),
    });
    const result = await betterstackLogTool.invoke({ query: "enrichment", lastMinutes: 15 });
    const parsed = JSON.parse(result);
    expect(parsed.logs).toHaveLength(2);
    expect(parsed.logs[0].message).toBe("Alert processed");
    expect(parsed.count).toBe(2);
    expect(parsed.query).toBe("enrichment");
  });

  it("returns empty when no matching logs", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [] }),
    });
    const result = await betterstackLogTool.invoke({ query: "nonexistent", lastMinutes: 5 });
    const parsed = JSON.parse(result);
    expect(parsed.logs).toHaveLength(0);
    expect(parsed.count).toBe(0);
  });

  it("handles HTTP error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    const result = await betterstackLogTool.invoke({ query: "test", lastMinutes: 10 });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("Invalid Better Stack credentials");
    expect(parsed.hint).toBeDefined();
  });

  it("handles network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await betterstackLogTool.invoke({ query: "test", lastMinutes: 10 });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("ECONNREFUSED");
    expect(parsed.retry).toBe(true);
  });

  it("handles missing token gracefully", async () => {
    vi.resetModules();
    vi.doMock("@easyoref/shared", async () => {
      const actual = await vi.importActual("@easyoref/shared");
      return {
        ...actual,
        config: {
          ...(actual as any).config ?? {},
          agent: {
            model: "test-model",
            apiKey: "test-key",
            mcpTools: true,
            clarifyFetchCount: 3,
            confidenceThreshold: 0.6,
            filterModel: "google/gemini-2.5-flash-lite",
            filterFallbackModel: "meta-llama/llama-3.3-70b-instruct:free",
            extractModel: "google/gemini-3.1-flash-lite-preview",
            extractFallbackModel: "meta-llama/llama-3.3-70b-instruct:free",
            channels: ["@idf_telegram", "@N12LIVE", "@kann_news"],
            areaLabels: { הרצליה: "Герцлия" },
          },
          logtailToken: "",
        },
      };
    });
    const toolsMod = await import("../src/tools/index.js");
    const result = await toolsMod.betterstackLogTool.invoke({ query: "test", lastMinutes: 10 });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("Better Stack token not configured");
  });
});
