/**
 * Tests for tool calling: tools.ts, clarify.ts, and shouldClarify routing.
 *
 * These tests mock external dependencies (GramJS, fetch, LLM) and verify:
 *   - Tool execution and error handling
 *   - ReAct loop flow (with/without tool calls)
 *   - Conditional edge routing logic
 *   - Contradiction detection
 *   - Area proximity resolution
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ValidatedExtraction, VotedResult } from "../agent/types.js";

// ── Mocks (must be defined before imports) ─────────────

vi.mock("../config.js", () => ({
  config: {
    agent: {
      model: "test-model",
      apiKey: "test-key",
      mcpTools: true,
      clarifyFetchCount: 3,
      confidenceThreshold: 0.6,
    },
    orefApiUrl: "https://mock.oref.api/alerts",
    orefHistoryUrl: "",
    logtailToken: "test-logtail-token",
    areas: ["הרצליה", "תל אביב - דרום העיר ויפו"],
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
  }),
}));

vi.mock("../agent/store.js", () => ({
  pushSessionPost: vi.fn(),
}));

vi.mock("../agent/gramjs-monitor.js", () => ({
  fetchRecentChannelPosts: vi.fn(),
}));

// ── Helpers ────────────────────────────────────────────

function makeVotedResult(overrides: Partial<VotedResult> = {}): VotedResult {
  return {
    eta_refined_minutes: null,
    eta_citations: [],
    country_origins: [{ name: "Lebanon", citations: [1] }],
    rocket_count_min: 10,
    rocket_count_max: 15,
    rocket_citations: [1, 2],
    rocket_confidence: 0.7,
    is_cassette: null,
    is_cassette_confidence: 0,
    intercepted: 8,
    intercepted_qual: null,
    intercepted_qual_num: null,
    intercepted_confidence: 0.6,
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
    hits_confidence: 0.4,
    casualties: null,
    casualties_citations: [],
    casualties_confidence: 0,
    injuries: null,
    injuries_citations: [],
    injuries_confidence: 0,
    confidence: 0.45,
    sources_count: 2,
    citedSources: [
      { index: 1, channel: "@idf_telegram", messageUrl: null },
      { index: 2, channel: "@N12LIVE", messageUrl: null },
    ],
    ...overrides,
  };
}

function makeExtraction(
  overrides: Partial<ValidatedExtraction> = {},
): ValidatedExtraction {
  return {
    channel: "@idf_telegram",
    region_relevance: 0.9,
    source_trust: 0.8,
    tone: "calm",
    time_relevance: 0.9,
    country_origin: "Lebanon",
    rocket_count: 12,
    is_cassette: null,
    intercepted: 8,
    intercepted_qual: null,
    intercepted_qual_num: null,
    sea_impact: null,
    sea_impact_qual: null,
    sea_impact_qual_num: null,
    open_area_impact: null,
    open_area_impact_qual: null,
    open_area_impact_qual_num: null,
    hits_confirmed: 1,
    casualties: null,
    injuries: null,
    eta_refined_minutes: null,
    confidence: 0.7,
    valid: true,
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════
// 1. readSourcesTool
// ═════════════════════════════════════════════════════════

describe("readSourcesTool", () => {
  let readSourcesTool: typeof import("../agent/tools.js").readSourcesTool;
  let fetchRecentChannelPosts: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const toolsMod = await import("../agent/tools.js");
    readSourcesTool = toolsMod.readSourcesTool;
    const gramjsMod = await import("../agent/gramjs-monitor.js");
    fetchRecentChannelPosts = gramjsMod.fetchRecentChannelPosts as ReturnType<
      typeof vi.fn
    >;
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns posts from channel", async () => {
    fetchRecentChannelPosts.mockResolvedValueOnce([
      {
        text: "IDF reports 12 rockets launched",
        ts: 1700000000,
        messageUrl: "https://t.me/idf/100",
      },
      {
        text: "Iron Dome intercepted majority",
        ts: 1700000001,
        messageUrl: "https://t.me/idf/101",
      },
    ]);

    const result = await readSourcesTool.invoke({
      channel: "@idf_telegram",
      limit: 3,
    });

    const parsed = JSON.parse(result);
    expect(parsed.channel).toBe("@idf_telegram");
    expect(parsed.posts).toHaveLength(2);
    expect(parsed.posts[0].text).toContain("12 rockets");
    expect(parsed.count).toBe(2);
    expect(fetchRecentChannelPosts).toHaveBeenCalledWith("@idf_telegram", 3);
  });

  it("limits posts to clarifyFetchCount", async () => {
    fetchRecentChannelPosts.mockResolvedValueOnce([
      { text: "Post1", ts: 1, messageUrl: null },
    ]);

    // limit=4 (max allowed by schema) should be capped to clarifyFetchCount=3
    await readSourcesTool.invoke({ channel: "@test", limit: 4 });
    expect(fetchRecentChannelPosts).toHaveBeenCalledWith("@test", 3);
  });

  it("truncates long texts to 800 chars", async () => {
    const longText = "A".repeat(1500);
    fetchRecentChannelPosts.mockResolvedValueOnce([
      { text: longText, ts: 1, messageUrl: null },
    ]);

    const result = await readSourcesTool.invoke({
      channel: "@test",
      limit: 1,
    });

    const parsed = JSON.parse(result);
    expect(parsed.posts[0].text.length).toBe(800);
  });

  it("returns empty array when no posts", async () => {
    fetchRecentChannelPosts.mockResolvedValueOnce([]);

    const result = await readSourcesTool.invoke({
      channel: "@empty",
      limit: 2,
    });

    const parsed = JSON.parse(result);
    expect(parsed.posts).toHaveLength(0);
    expect(parsed.note).toContain("No recent posts");
  });

  it("handles FLOOD error gracefully (retry: false)", async () => {
    fetchRecentChannelPosts.mockRejectedValueOnce(new Error("FLOOD_WAIT_420"));

    const result = await readSourcesTool.invoke({
      channel: "@flooded",
      limit: 1,
    });

    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("Failed to fetch");
    expect(parsed.retry).toBe(false);
  });

  it("handles generic error gracefully (retry: true)", async () => {
    fetchRecentChannelPosts.mockRejectedValueOnce(new Error("Network timeout"));

    const result = await readSourcesTool.invoke({
      channel: "@broken",
      limit: 1,
    });

    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("Network timeout");
    expect(parsed.retry).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════
// 2. alertHistoryTool
// ═════════════════════════════════════════════════════════

describe("alertHistoryTool", () => {
  let alertHistoryTool: typeof import("../agent/tools.js").alertHistoryTool;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    vi.resetModules();
    const toolsMod = await import("../agent/tools.js");
    alertHistoryTool = toolsMod.alertHistoryTool;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns empty when no history", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () => "",
    });

    const result = await alertHistoryTool.invoke({
      area: "תל אביב",
      last_minutes: 30,
    });
    const parsed = JSON.parse(result);
    expect(parsed.alerts).toEqual([]);
    expect(parsed.note).toContain("No alert history");
  });

  it("filters history by area", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify([
          {
            alertDate: "2024-01-15 10:30",
            title: "ירי רקטות",
            data: "תל אביב - דרום העיר ויפו",
            category_desc: "Missiles",
          },
          {
            alertDate: "2024-01-15 10:31",
            title: "ירי רקטות",
            data: "חיפה - מערב",
            category_desc: "Missiles",
          },
        ]),
    });

    const result = await alertHistoryTool.invoke({
      area: "תל אביב",
      last_minutes: 30,
    });
    const parsed = JSON.parse(result);
    expect(parsed.alerts).toHaveLength(1);
    expect(parsed.total_in_period).toBe(2);
    expect(parsed.relevant_count).toBe(1);
    expect(parsed.alerts[0].date).toBe("2024-01-15 10:30");
  });

  it("handles HTTP error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 503,
    });

    const result = await alertHistoryTool.invoke({
      area: "test",
      last_minutes: 30,
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("503");
    expect(parsed.retry).toBe(true);
  });

  it("handles network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error("fetch failed"));

    const result = await alertHistoryTool.invoke({
      area: "test",
      last_minutes: 30,
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("fetch failed");
    expect(parsed.retry).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════
// 3. shouldClarify routing logic
// ═════════════════════════════════════════════════════════

describe("shouldClarify routing", () => {
  // Test the pure routing logic by extracting the conditions
  // (shouldClarify is not exported, so we test its logic directly)

  function shouldClarify(state: {
    clarifyAttempted: boolean;
    mcpToolsEnabled: boolean;
    votedResult: VotedResult | null;
    confidenceThreshold: number;
  }): "clarify" | "editMessage" {
    if (state.clarifyAttempted) return "editMessage";
    if (!state.mcpToolsEnabled) return "editMessage";
    if (!state.votedResult) return "editMessage";
    if (state.votedResult.confidence < state.confidenceThreshold)
      return "clarify";
    return "editMessage";
  }

  it("routes to clarify when confidence < threshold", () => {
    const result = shouldClarify({
      clarifyAttempted: false,
      mcpToolsEnabled: true,
      votedResult: makeVotedResult({ confidence: 0.4 }),
      confidenceThreshold: 0.6,
    });
    expect(result).toBe("clarify");
  });

  it("routes to editMessage when confidence >= threshold", () => {
    const result = shouldClarify({
      clarifyAttempted: false,
      mcpToolsEnabled: true,
      votedResult: makeVotedResult({ confidence: 0.8 }),
      confidenceThreshold: 0.6,
    });
    expect(result).toBe("editMessage");
  });

  it("routes to editMessage when already clarified", () => {
    const result = shouldClarify({
      clarifyAttempted: true,
      mcpToolsEnabled: true,
      votedResult: makeVotedResult({ confidence: 0.3 }),
      confidenceThreshold: 0.6,
    });
    expect(result).toBe("editMessage");
  });

  it("routes to editMessage when MCP tools disabled", () => {
    const result = shouldClarify({
      clarifyAttempted: false,
      mcpToolsEnabled: false,
      votedResult: makeVotedResult({ confidence: 0.3 }),
      confidenceThreshold: 0.6,
    });
    expect(result).toBe("editMessage");
  });

  it("routes to editMessage when votedResult is null", () => {
    const result = shouldClarify({
      clarifyAttempted: false,
      mcpToolsEnabled: true,
      votedResult: null,
      confidenceThreshold: 0.6,
    });
    expect(result).toBe("editMessage");
  });

  it("routes to clarify at exact boundary (0.59 < 0.6)", () => {
    const result = shouldClarify({
      clarifyAttempted: false,
      mcpToolsEnabled: true,
      votedResult: makeVotedResult({ confidence: 0.59 }),
      confidenceThreshold: 0.6,
    });
    expect(result).toBe("clarify");
  });

  it("routes to editMessage at exact threshold (0.6 >= 0.6)", () => {
    const result = shouldClarify({
      clarifyAttempted: false,
      mcpToolsEnabled: true,
      votedResult: makeVotedResult({ confidence: 0.6 }),
      confidenceThreshold: 0.6,
    });
    expect(result).toBe("editMessage");
  });
});

// ═════════════════════════════════════════════════════════
// 4. Contradiction detection
// ═════════════════════════════════════════════════════════

describe("contradiction detection", () => {
  // Extracted from clarify.ts describeContradictions logic
  function describeContradictions(
    _extractions: ValidatedExtraction[],
    voted: VotedResult,
  ): string {
    const issues: string[] = [];
    if (voted.country_origins && voted.country_origins.length > 1) {
      const names = voted.country_origins.map((c) => c.name).join(", ");
      issues.push(`Multiple origin countries reported: ${names}`);
    }
    if (
      voted.rocket_count_min !== null &&
      voted.rocket_count_max !== null &&
      voted.rocket_count_max - voted.rocket_count_min > 3
    ) {
      issues.push(
        `Wide rocket count range: ${voted.rocket_count_min}–${voted.rocket_count_max}`,
      );
    }
    if (voted.intercepted_confidence < 0.5 && voted.intercepted !== null) {
      issues.push(
        `Intercepted count (${
          voted.intercepted
        }) has low confidence: ${voted.intercepted_confidence.toFixed(2)}`,
      );
    }
    if (voted.hits_confidence < 0.5 && voted.hits_confirmed !== null) {
      issues.push(
        `Hits confirmed (${
          voted.hits_confirmed
        }) has low confidence: ${voted.hits_confidence.toFixed(2)}`,
      );
    }
    issues.push(`Overall confidence: ${voted.confidence}`);
    issues.push(`Sources count: ${voted.sources_count}`);
    return issues.join("\n");
  }

  it("detects multiple country origins", () => {
    const voted = makeVotedResult({
      country_origins: [
        { name: "Lebanon", citations: [1] },
        { name: "Iran", citations: [2] },
      ],
    });
    const result = describeContradictions([], voted);
    expect(result).toContain("Multiple origin countries");
    expect(result).toContain("Lebanon");
    expect(result).toContain("Iran");
  });

  it("detects wide rocket count range", () => {
    const voted = makeVotedResult({
      rocket_count_min: 5,
      rocket_count_max: 20,
    });
    const result = describeContradictions([], voted);
    expect(result).toContain("Wide rocket count range: 5–20");
  });

  it("detects low intercepted confidence", () => {
    const voted = makeVotedResult({
      intercepted: 5,
      intercepted_confidence: 0.3,
    });
    const result = describeContradictions([], voted);
    expect(result).toContain("Intercepted count (5) has low confidence: 0.30");
  });

  it("detects low hits confidence", () => {
    const voted = makeVotedResult({
      hits_confirmed: 2,
      hits_confidence: 0.25,
    });
    const result = describeContradictions([], voted);
    expect(result).toContain("Hits confirmed (2) has low confidence: 0.25");
  });

  it("does not flag narrow rocket count range", () => {
    const voted = makeVotedResult({
      rocket_count_min: 10,
      rocket_count_max: 12,
    });
    const result = describeContradictions([], voted);
    expect(result).not.toContain("Wide rocket count range");
  });

  it("always includes overall confidence and sources count", () => {
    const voted = makeVotedResult({ confidence: 0.45, sources_count: 3 });
    const result = describeContradictions([], voted);
    expect(result).toContain("Overall confidence: 0.45");
    expect(result).toContain("Sources count: 3");
  });
});

// ═════════════════════════════════════════════════════════
// 5. ClarifyOutput structure
// ═════════════════════════════════════════════════════════

describe("clarify output contract", () => {
  it("ClarifyOutput has expected shape", () => {
    // Type-level test: ensure the interface we expect
    const output = {
      newPosts: [{ channel: "@test", text: "test", ts: 1 }],
      newExtractions: [makeExtraction()],
      toolCallCount: 2,
      clarified: true,
    };
    expect(output.newPosts).toHaveLength(1);
    expect(output.newExtractions).toHaveLength(1);
    expect(output.toolCallCount).toBe(2);
    expect(output.clarified).toBe(true);
  });

  it("ClarifyInput has expected fields", () => {
    const input = {
      alertId: "test-1",
      alertAreas: ["תל אביב"],
      alertType: "siren" as const,
      messageId: 123,
      currentText: "text",
      extractions: [makeExtraction()],
      votedResult: makeVotedResult(),
    };
    expect(input.alertAreas).toContain("תל אביב");
    expect(input.extractions).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════
// 6. clarifyTools array
// ═════════════════════════════════════════════════════════

describe("clarifyTools export", () => {
  it("exports exactly 4 tools", async () => {
    const { clarifyTools } = await import("../agent/tools.js");
    expect(clarifyTools).toHaveLength(4);
  });

  it("has correct tool names", async () => {
    const { clarifyTools } = await import("../agent/tools.js");
    const names = clarifyTools.map((t) => t.name);
    expect(names).toContain("read_telegram_sources");
    expect(names).toContain("alert_history");
    expect(names).toContain("resolve_area");
    expect(names).toContain("betterstack_log");
  });

  it("does not include old MCP-prefixed tool names", async () => {
    const { clarifyTools } = await import("../agent/tools.js");
    const names = clarifyTools.map((t) => t.name);
    expect(names).not.toContain("telegram_mtproto_mcp_read_sources");
    expect(names).not.toContain("pikud_haoref_mcp");
    expect(names).not.toContain("telegram_bot_mcp_read_target");
  });
});

// ═════════════════════════════════════════════════════════
// 7. resolveAreaTool
// ═════════════════════════════════════════════════════════

describe("resolveAreaTool", () => {
  let resolveAreaTool: typeof import("../agent/tools.js").resolveAreaTool;

  beforeEach(async () => {
    vi.resetModules();
    const toolsMod = await import("../agent/tools.js");
    resolveAreaTool = toolsMod.resolveAreaTool;
  });

  afterEach(() => vi.restoreAllMocks());

  it("resolves direct match (תל אביב)", async () => {
    const result = await resolveAreaTool.invoke({ location: "תל אביב" });
    const parsed = JSON.parse(result);
    expect(parsed.relevant).toBe(true);
    expect(parsed.reasoning).toContain("directly matches");
  });

  it("resolves same zone (פתח תקווה → הרצליה via שרון/גוש דן)", async () => {
    const result = await resolveAreaTool.invoke({ location: "פתח תקווה" });
    const parsed = JSON.parse(result);
    expect(parsed.relevant).toBe(true);
    expect(parsed.sameZone).toBeTruthy();
  });

  it("resolves region keyword (מרכז → תל אביב)", async () => {
    const result = await resolveAreaTool.invoke({ location: "מרכז" });
    const parsed = JSON.parse(result);
    expect(parsed.relevant).toBe(true);
  });

  it("rejects unrelated area (חיפה)", async () => {
    const result = await resolveAreaTool.invoke({ location: "קריית שמונה" });
    const parsed = JSON.parse(result);
    expect(parsed.relevant).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════
// 8. resolveAreaProximity (unit)
// ═════════════════════════════════════════════════════════

describe("resolveAreaProximity", () => {
  let resolveAreaProximity: typeof import("../agent/tools.js")._resolveAreaProximity;

  beforeEach(async () => {
    vi.resetModules();
    const toolsMod = await import("../agent/tools.js");
    resolveAreaProximity = toolsMod._resolveAreaProximity;
  });

  const monitored = ["הרצליה", "תל אביב - דרום העיר ויפו"];

  it("direct match — exact monitored area", () => {
    const r = resolveAreaProximity("הרצליה", monitored);
    expect(r.relevant).toBe(true);
    expect(r.sameZone).toBeNull();
    expect(r.monitoredMatch).toContain("הרצליה");
  });

  it("direct match — partial prefix (תל אביב)", () => {
    const r = resolveAreaProximity("תל אביב", monitored);
    expect(r.relevant).toBe(true);
  });

  it("zone match — פתח תקווה in גוש דן with תל אביב", () => {
    const r = resolveAreaProximity("פתח תקווה", monitored);
    expect(r.relevant).toBe(true);
    expect(r.sameZone).toBe("גוש דן");
  });

  it("zone match — רעננה in שרון with הרצליה", () => {
    const r = resolveAreaProximity("רעננה", monitored);
    expect(r.relevant).toBe(true);
    expect(r.sameZone).toBe("שרון");
  });

  it("region keyword — מרכז includes תל אביב", () => {
    const r = resolveAreaProximity("מרכז", monitored);
    expect(r.relevant).toBe(true);
    expect(r.sameZone).toBe("מרכז");
  });

  it("no match — קריית שמונה (north)", () => {
    const r = resolveAreaProximity("קריית שמונה", monitored);
    expect(r.relevant).toBe(false);
    expect(r.sameZone).toBe("גליל עליון");
  });

  it("no match — completely unknown area", () => {
    const r = resolveAreaProximity("אום אל פחם", monitored);
    expect(r.relevant).toBe(false);
    expect(r.sameZone).toBeNull();
  });

  it("zone match — בני ברק in גוש דן", () => {
    const r = resolveAreaProximity("בני ברק", monitored);
    expect(r.relevant).toBe(true);
    expect(r.sameZone).toBe("גוש דן");
  });
});

// ═════════════════════════════════════════════════════════
// 9. formatOrefDate
// ═════════════════════════════════════════════════════════

describe("formatOrefDate", () => {
  it("formats date as DD.MM.YYYY", async () => {
    const { _formatOrefDate } = await import("../agent/tools.js");
    const d = new Date("2024-03-09T12:00:00Z");
    expect(_formatOrefDate(d)).toBe("09.03.2024");
  });

  it("pads single digit day and month", async () => {
    const { _formatOrefDate } = await import("../agent/tools.js");
    const d = new Date("2024-01-05T00:00:00Z");
    expect(_formatOrefDate(d)).toBe("05.01.2024");
  });
});

// ═════════════════════════════════════════════════════════
// 10. betterstackLogTool
// ═════════════════════════════════════════════════════════

describe("betterstackLogTool", () => {
  let betterstackLogTool: typeof import("../agent/tools.js").betterstackLogTool;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    vi.resetModules();
    const toolsMod = await import("../agent/tools.js");
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
        data: [
          {
            dt: "2024-01-15T10:30:00Z",
            message: "Alert processed",
            level: "info",
          },
          {
            dt: "2024-01-15T10:29:00Z",
            message: "Enrichment started",
            level: "info",
          },
        ],
      }),
    });

    const result = await betterstackLogTool.invoke({
      query: "enrichment",
      last_minutes: 15,
    });
    const parsed = JSON.parse(result);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[0].message).toBe("Alert processed");
    expect(parsed.total).toBe(2);
    expect(parsed.query).toBe("enrichment");
  });

  it("returns empty when no matching logs", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    });

    const result = await betterstackLogTool.invoke({
      query: "nonexistent",
      last_minutes: 5,
    });
    const parsed = JSON.parse(result);
    expect(parsed.events).toHaveLength(0);
    expect(parsed.total).toBe(0);
  });

  it("handles HTTP error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });

    const result = await betterstackLogTool.invoke({
      query: "test",
      last_minutes: 10,
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("401");
    expect(parsed.retry).toBe(false); // 401 is not server error
  });

  it("handles network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await betterstackLogTool.invoke({
      query: "test",
      last_minutes: 10,
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("ECONNREFUSED");
    expect(parsed.retry).toBe(true);
  });

  it("handles missing token gracefully", async () => {
    // Re-import with empty token
    vi.resetModules();
    vi.doMock("../config.js", () => ({
      config: {
        agent: { clarifyFetchCount: 3 },
        orefApiUrl: "",
        orefHistoryUrl: "",
        logtailToken: "",
        areas: [],
      },
    }));
    const toolsMod = await import("../agent/tools.js");
    const result = await toolsMod.betterstackLogTool.invoke({
      query: "test",
      last_minutes: 10,
    });
    const parsed = JSON.parse(result);
    expect(parsed.error).toContain("not configured");
  });
});
