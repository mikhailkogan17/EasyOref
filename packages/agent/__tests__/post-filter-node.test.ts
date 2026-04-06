/**
 * Unit tests for post-filter-node.
 *
 * Tests pure / near-pure paths only — no real LLM, no network.
 * Mocks invokeWithFallback to control "verification" responses.
 *
 * Covers:
 *  - No extractions → early return
 *  - Missing source.text → isValid: false without LLM call
 *  - LLM says supported=false → isValid: false
 *  - LLM says supported=true, non-location insight → isValid: true
 *  - LLM says supported=true, location insight, out-of-zone → isValid: false
 *  - LLM says supported=true, location insight, exact_user_zone → isValid: true + insightLocation
 *  - LLM says supported=true, location insight, broader region → isValid: true + user_macro_region
 */

import type { InsightType } from "@easyoref/shared";
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
        mcpTools: false,
        clarifyFetchCount: 3,
        confidenceThreshold: 0.6,
        channels: [],
        areaLabels: {},
      },
      botToken: "",
      areas: ["תל אביב - דרום העיר ויפו"],
      language: "ru",
    },
  };
});

vi.mock("@easyoref/shared/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// invokeWithFallback mock — controlled per-test via mockResolvedValue
const mockInvokeWithFallback = vi.fn();
vi.mock("../src/models.js", () => ({
  extractModel: "mock-model",
  extractFallback: "mock-fallback",
  preFilterModel: "mock-model",
  preFilterFallback: "mock-fallback",
  invokeWithFallback: (...args: unknown[]) => mockInvokeWithFallback(...args),
}));

// resolveArea mock — controlled per-test
const mockResolveArea = vi.fn();
vi.mock("../src/tools/resolve-area.js", () => ({
  resolveArea: (...args: unknown[]) => mockResolveArea(...args),
}));

// ── Import (after mocks) ──────────────────────────────────

import { postFilterNode } from "../src/nodes/post-filter-node.js";

// ── Helpers ───────────────────────────────────────────────

function makeBaseState(overrides: Record<string, unknown> = {}) {
  return {
    messages: [],
    alertId: "alert-1",
    alertTs: Date.now(),
    alertType: "red_alert" as const,
    alertAreas: ["תל אביב"],
    chatId: "-1001234567890",
    messageId: 100,
    isCaption: false,
    currentText: "Red Alert",
    extractedInsights: [],
    filteredInsights: [],
    synthesizedInsights: [],
    votedResult: undefined,
    clarifyAttempted: false,
    previousInsights: [],
    telegramMessages: [],
    ...overrides,
  };
}

/**
 * Minimal InsightType-compatible object with the extra runtime fields
 * post-filter-node expects (source.text, source.channelId, extractionReason).
 */
function makeInsight(overrides: {
  kindLiteral?: string;
  sourceText?: string;
  channelId?: string;
  location?: string;
} = {}): InsightType & {
  source: { text?: string; channelId?: string };
  extractionReason?: string;
} {
  const kindLiteral = overrides.kindLiteral ?? "rocket_count";
  return {
    kind: { kind: kindLiteral, value: { type: "exact", value: 5 } } as InsightType["kind"],
    timeRelevance: 1,
    regionRelevance: 1,
    confidence: 0.8,
    source: {
      channelId: overrides.channelId ?? "@test_channel",
      sourceType: "telegram_channel" as const,
      timestamp: Date.now(),
      text: overrides.sourceText ?? "Rockets fired from Gaza",
    },
    timeStamp: new Date().toISOString(),
    extractionReason: "test insight",
    // Add location for impact/casualities insights
    ...(overrides.location
      ? { kind: { kind: kindLiteral, value: {}, location: overrides.location } as InsightType["kind"] }
      : {}),
  };
}

// ─────────────────────────────────────────────────────────
// postFilterNode — edge cases
// ─────────────────────────────────────────────────────────

describe("postFilterNode", () => {
  it("returns early message when no extractions", async () => {
    const state = makeBaseState({ extractedInsights: [] });
    const result = await postFilterNode(state as any);

    expect(result.messages).toHaveLength(1);
    expect(result.filteredInsights).toBeUndefined(); // early return doesn't set it
    expect(mockInvokeWithFallback).not.toHaveBeenCalled();
  });

  it("marks insight invalid when source.text is missing — no LLM call", async () => {
    const insight = makeInsight({ sourceText: "" });
    const state = makeBaseState({ extractedInsights: [insight] });

    const result = await postFilterNode(state as any);

    expect(mockInvokeWithFallback).not.toHaveBeenCalled();
    expect(result.filteredInsights).toHaveLength(1);
    expect(result.filteredInsights![0].isValid).toBe(false);
    expect(result.filteredInsights![0].rejectionReason).toBe("source_text_missing");
    expect(result.filteredInsights![0].sourceTrust).toBe(0);
  });

  it("marks insight invalid when source.text is undefined — no LLM call", async () => {
    const insight = makeInsight({ sourceText: undefined as unknown as string });
    // Force text to undefined to simulate missing field
    (insight.source as any).text = undefined;
    const state = makeBaseState({ extractedInsights: [insight] });

    const result = await postFilterNode(state as any);

    expect(mockInvokeWithFallback).not.toHaveBeenCalled();
    expect(result.filteredInsights![0].isValid).toBe(false);
    expect(result.filteredInsights![0].rejectionReason).toBe("source_text_missing");
  });

  it("marks insight invalid when LLM returns supported=false (resolved phase)", async () => {
    mockInvokeWithFallback.mockResolvedValueOnce({
      structuredResponse: { supported: false, reason: "not in post", sourceTrust: 0.3 },
    });

    const insight = makeInsight({ sourceText: "Some post text" });
    const state = makeBaseState({ extractedInsights: [insight], alertType: "resolved" });

    const result = await postFilterNode(state as any);

    expect(result.filteredInsights).toHaveLength(1);
    expect(result.filteredInsights![0].isValid).toBe(false);
    expect(result.filteredInsights![0].rejectionReason).toBe("not in post");
    expect(result.filteredInsights![0].sourceTrust).toBe(0.3);
  });

  it("soft-passes insight during red_alert when LLM returns supported=false", async () => {
    mockInvokeWithFallback.mockResolvedValueOnce({
      structuredResponse: { supported: false, reason: "not in post", sourceTrust: 0.3 },
    });

    const insight = makeInsight({ sourceText: "Some post text" });
    const state = makeBaseState({ extractedInsights: [insight], alertType: "red_alert" });

    const result = await postFilterNode(state as any);

    expect(result.filteredInsights).toHaveLength(1);
    expect(result.filteredInsights![0].isValid).toBe(true);
    expect(result.filteredInsights![0].rejectionReason).toBe("soft_pass_critical_phase");
    expect(result.filteredInsights![0].sourceTrust).toBe(0.2);
    // confidence preserved from original insight (0.8), fallback 0.3 only when undefined
    expect(result.filteredInsights![0].confidence).toBe(0.8);
  });

  it("soft-passes insight during early_warning when LLM returns supported=false", async () => {
    mockInvokeWithFallback.mockResolvedValueOnce({
      structuredResponse: { supported: false, reason: "weak evidence", sourceTrust: 0.4 },
    });

    const insight = makeInsight({ sourceText: "Possible launch detected" });
    const state = makeBaseState({ extractedInsights: [insight], alertType: "early_warning" });

    const result = await postFilterNode(state as any);

    expect(result.filteredInsights).toHaveLength(1);
    expect(result.filteredInsights![0].isValid).toBe(true);
    expect(result.filteredInsights![0].rejectionReason).toBe("soft_pass_critical_phase");
    expect(result.filteredInsights![0].sourceTrust).toBe(0.2);
  });

  it("marks insight valid when LLM returns supported=true for non-location insight", async () => {
    mockInvokeWithFallback.mockResolvedValueOnce({
      structuredResponse: { supported: true, reason: "clear evidence", sourceTrust: 0.9 },
    });

    const insight = makeInsight({ kindLiteral: "rocket_count", sourceText: "10 rockets fired" });
    const state = makeBaseState({ extractedInsights: [insight] });

    const result = await postFilterNode(state as any);

    expect(result.filteredInsights).toHaveLength(1);
    expect(result.filteredInsights![0].isValid).toBe(true);
    expect(result.filteredInsights![0].sourceTrust).toBe(0.9);
    expect(result.filteredInsights![0].insightLocation).toBeUndefined();
    // resolveArea should NOT be called for non-location insights
    expect(mockResolveArea).not.toHaveBeenCalled();
  });

  it("marks location insight invalid when area is out of user zone", async () => {
    mockInvokeWithFallback.mockResolvedValueOnce({
      structuredResponse: { supported: true, reason: "ok", sourceTrust: 0.7 },
    });
    mockResolveArea.mockResolvedValueOnce({ relevant: false, tier: "none" });

    const insight = makeInsight({ kindLiteral: "impact", sourceText: "Hit in Haifa" });
    (insight.kind as any).location = "Haifa";

    const state = makeBaseState({ extractedInsights: [insight] });
    const result = await postFilterNode(state as any);

    expect(result.filteredInsights![0].isValid).toBe(false);
    expect(result.filteredInsights![0].insightLocation).toBe("not_a_user_zone");
    expect(result.filteredInsights![0].rejectionReason).toContain("location_not_user_zone");
  });

  it("marks location insight valid with exact_user_zone when resolveArea returns exact tier", async () => {
    mockInvokeWithFallback.mockResolvedValueOnce({
      structuredResponse: { supported: true, reason: "ok", sourceTrust: 0.85 },
    });
    mockResolveArea.mockResolvedValueOnce({ relevant: true, tier: "exact" });

    const insight = makeInsight({ kindLiteral: "impact", sourceText: "Hit in Tel Aviv" });
    (insight.kind as any).location = "Tel Aviv";

    const state = makeBaseState({ extractedInsights: [insight] });
    const result = await postFilterNode(state as any);

    expect(result.filteredInsights![0].isValid).toBe(true);
    expect(result.filteredInsights![0].insightLocation).toBe("exact_user_zone");
  });

  it("marks location insight valid with user_macro_region when resolveArea returns broader tier", async () => {
    mockInvokeWithFallback.mockResolvedValueOnce({
      structuredResponse: { supported: true, reason: "ok", sourceTrust: 0.75 },
    });
    mockResolveArea.mockResolvedValueOnce({ relevant: true, tier: "macro" });

    const insight = makeInsight({ kindLiteral: "impact", sourceText: "Hit in Dan region" });
    (insight.kind as any).location = "Dan region";

    const state = makeBaseState({ extractedInsights: [insight] });
    const result = await postFilterNode(state as any);

    expect(result.filteredInsights![0].isValid).toBe(true);
    expect(result.filteredInsights![0].insightLocation).toBe("user_macro_region");
  });

  it("processes multiple insights independently", async () => {
    // insight 1: valid (LLM supported)
    mockInvokeWithFallback.mockResolvedValueOnce({
      structuredResponse: { supported: true, reason: "ok", sourceTrust: 0.8 },
    });
    // insight 2: invalid (LLM not supported)
    mockInvokeWithFallback.mockResolvedValueOnce({
      structuredResponse: { supported: false, reason: "weak", sourceTrust: 0.3 },
    });

    const insights = [
      makeInsight({ sourceText: "first post" }),
      makeInsight({ sourceText: "second post" }),
    ];
    const state = makeBaseState({ extractedInsights: insights, alertType: "resolved" });
    const result = await postFilterNode(state as any);

    expect(result.filteredInsights).toHaveLength(2);
    expect(result.filteredInsights![0].isValid).toBe(true);
    expect(result.filteredInsights![1].isValid).toBe(false);
  });

  it("handles null structuredResponse gracefully during resolved phase (LLM failure path)", async () => {
    mockInvokeWithFallback.mockResolvedValueOnce({ structuredResponse: null });

    const insight = makeInsight({ sourceText: "some post" });
    const state = makeBaseState({ extractedInsights: [insight], alertType: "resolved" });

    const result = await postFilterNode(state as any);

    // null verification.supported → falsy → invalid (resolved = strict)
    expect(result.filteredInsights![0].isValid).toBe(false);
    expect(result.filteredInsights![0].rejectionReason).toBe("source_verification_failed");
  });

  it("soft-passes null structuredResponse during red_alert (LLM failure path)", async () => {
    mockInvokeWithFallback.mockResolvedValueOnce({ structuredResponse: null });

    const insight = makeInsight({ sourceText: "some post" });
    const state = makeBaseState({ extractedInsights: [insight], alertType: "red_alert" });

    const result = await postFilterNode(state as any);

    // null verification.supported → falsy → but red_alert triggers soft pass
    expect(result.filteredInsights![0].isValid).toBe(true);
    expect(result.filteredInsights![0].rejectionReason).toBe("soft_pass_critical_phase");
  });
});
