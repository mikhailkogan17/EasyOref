/**
 * Q&A graph tests — intent classifier, answer node (mocked), get_last_attack tool, full graph integration.
 */
import { describe, expect, it, vi } from "vitest";

// ── findLastAttack tests (deterministic, no mocks) ───────────────────────

import type { OrefHistoryEntry } from "@easyoref/shared";
import { findLastAttack } from "../src/utils/query-history.js";

describe("findLastAttack", () => {
  const makeEntry = (
    alertDate: string,
    category: number,
    data = "תל אביב - דרום העיר ויפו",
  ): OrefHistoryEntry => ({
    alertDate,
    title: "test",
    data,
    category,
  });

  it("returns null when no entries match zones", () => {
    const history = [makeEntry("2026-04-07T09:05:00", 1, "חיפה")];
    const result = findLastAttack(history, ["תל אביב - דרום העיר ויפו"]);
    expect(result).toBeNull();
  });

  it("returns null for empty history", () => {
    const result = findLastAttack([], ["תל אביב - דרום העיר ויפו"]);
    expect(result).toBeNull();
  });

  it("finds last siren with early_warning and resolved", () => {
    const history = [
      makeEntry("2026-04-07T09:05:00", 14), // early warning
      makeEntry("2026-04-07T09:10:00", 1), // siren
      makeEntry("2026-04-07T09:12:00", 1), // another siren
      makeEntry("2026-04-07T09:17:00", 13), // resolved
    ];
    const result = findLastAttack(history, ["תל אביב - דרום העיר ויפו"]);
    expect(result).not.toBeNull();
    expect(result!.early_time).toBe("09:05");
    expect(result!.siren_times).toEqual(["09:10", "09:12"]);
    expect(result!.resolved_time).toBe("09:17");
  });

  it("returns only early_time when no sirens exist", () => {
    const history = [makeEntry("2026-04-07T09:05:00", 14)];
    const result = findLastAttack(history, ["תל אביב - דרום העיר ויפו"]);
    expect(result).not.toBeNull();
    expect(result!.early_time).toBe("09:05");
    expect(result!.siren_times).toEqual([]);
    expect(result!.resolved_time).toBeNull();
  });

  it("finds last attack when multiple attacks in history", () => {
    const history = [
      // First attack
      makeEntry("2026-04-07T09:05:00", 14),
      makeEntry("2026-04-07T09:10:00", 1),
      makeEntry("2026-04-07T09:17:00", 13),
      // Second attack (last one)
      makeEntry("2026-04-07T18:16:00", 14),
      makeEntry("2026-04-07T18:18:00", 1),
      makeEntry("2026-04-07T18:28:00", 13),
    ];
    const result = findLastAttack(history, ["תל אביב - דרום העיר ויפו"]);
    expect(result).not.toBeNull();
    expect(result!.early_time).toBe("18:16");
    expect(result!.siren_times).toEqual(["18:18"]);
    expect(result!.resolved_time).toBe("18:28");
  });

  it("handles siren without early_warning", () => {
    const history = [
      makeEntry("2026-04-07T13:06:00", 1),
      makeEntry("2026-04-07T13:17:00", 13),
    ];
    const result = findLastAttack(history, ["תל אביב - דרום העיר ויפו"]);
    expect(result).not.toBeNull();
    expect(result!.early_time).toBeNull();
    expect(result!.siren_times).toEqual(["13:06"]);
    expect(result!.resolved_time).toBe("13:17");
  });

  it("handles siren without resolved", () => {
    const history = [
      makeEntry("2026-04-07T18:16:00", 14),
      makeEntry("2026-04-07T18:18:00", 1),
    ];
    const result = findLastAttack(history, ["תל אביב - דרום העיר ויפו"]);
    expect(result).not.toBeNull();
    expect(result!.early_time).toBe("18:16");
    expect(result!.siren_times).toEqual(["18:18"]);
    expect(result!.resolved_time).toBeNull();
  });
});

// ── Intent node tests (no mocks needed — purely deterministic) ─────────────

import { intentNode } from "../src/graphs/qa/nodes/intent.js";
import type { QaState } from "../src/graphs/qa/qa-graph.js";

function makeState(userMessage: string): QaState {
  return {
    userMessage,
    chatId: "123",
    language: "ru",
    intent: "general_security",
    context: "",
    answer: "",
    sources: [],
    history: [],
    posts: [],
  };
}

describe("intentNode", () => {
  it("classifies 'alert' → current_alert", async () => {
    const result = await intentNode(makeState("What is the current alert?"));
    expect(result.intent).toBe("current_alert");
  });

  it("classifies Hebrew 'מתקפה' → current_alert", async () => {
    const result = await intentNode(makeState("מה קורה עם המתקפה?"));
    expect(result.intent).toBe("current_alert");
  });

  it("classifies Russian 'тревог' → current_alert", async () => {
    const result = await intentNode(makeState("что за тревога сейчас?"));
    expect(result.intent).toBe("current_alert");
  });

  it("classifies 'history' → recent_history", async () => {
    const result = await intentNode(makeState("show me history"));
    expect(result.intent).toBe("recent_history");
  });

  it("classifies Hebrew 'אתמול' → recent_history", async () => {
    const result = await intentNode(makeState("מה היה אתמול?"));
    expect(result.intent).toBe("recent_history");
  });

  it("classifies Russian 'вчера' → recent_history", async () => {
    const result = await intentNode(makeState("что было вчера?"));
    expect(result.intent).toBe("recent_history");
  });

  it("classifies 'help' → bot_help", async () => {
    const result = await intentNode(makeState("help"));
    expect(result.intent).toBe("bot_help");
  });

  it("classifies '/start' → bot_help", async () => {
    const result = await intentNode(makeState("start"));
    expect(result.intent).toBe("bot_help");
  });

  it("classifies Hebrew 'עזרה' → bot_help", async () => {
    const result = await intentNode(makeState("עזרה"));
    expect(result.intent).toBe("bot_help");
  });

  it("classifies 'Russian помощь' → bot_help", async () => {
    const result = await intentNode(makeState("помощь"));
    expect(result.intent).toBe("bot_help");
  });

  it("defaults to general_security for unknown messages", async () => {
    const result = await intentNode(makeState("is it safe to go outside?"));
    expect(result.intent).toBe("general_security");
  });

  it("defaults to general_security for generic question", async () => {
    const result = await intentNode(makeState("what happened in Tel Aviv?"));
    expect(result.intent).toBe("general_security");
  });

  it("classifies off-topic → off_topic", async () => {
    const result = await intentNode(makeState("what is the weather today?"));
    expect(result.intent).toBe("off_topic");
  });
});

// ── Answer node tests (mocked LLM) ─────────────────────────────────────────

describe("answerNode (mocked LLM)", () => {
  it("returns context directly for bot_help intent", async () => {
    const { answerNode } = await import("../src/graphs/qa/nodes/answer.js");
    const state: QaState = {
      ...makeState("help"),
      intent: "bot_help",
      context: "EasyOref helps you with alerts.",
    };
    const result = await answerNode(state);
    expect(result.answer).toBe("EasyOref helps you with alerts.");
    expect(result.sources).toEqual([]);
  });

  it("handles LLM failure gracefully", async () => {
    vi.mock("@langchain/openrouter", () => ({
      ChatOpenRouter: vi.fn().mockImplementation(() => ({
        bindTools: vi.fn().mockReturnValue({
          invoke: vi.fn().mockRejectedValue(new Error("API error")),
        }),
        invoke: vi.fn().mockRejectedValue(new Error("API error")),
      })),
    }));

    const { answerNode: answerNodeMocked } =
      await import("../src/graphs/qa/nodes/answer.js");
    const state: QaState = {
      ...makeState("what is happening?"),
      intent: "current_alert",
      context: "Active alert in Tel Aviv.",
    };
    const result = await answerNodeMocked(state);
    expect(result.answer).toBeTruthy();
    expect(typeof result.answer).toBe("string");

    vi.restoreAllMocks();
  });
});

// ── Full graph integration test (requires OPENROUTER_API_KEY) ──────────────

describe("runQa integration", () => {
  const hasApiKey = Boolean(process.env.OPENROUTER_API_KEY);

  it.skipIf(!hasApiKey)(
    "returns a non-empty answer for a bot_help question",
    async () => {
      vi.mock("@easyoref/shared", async (importOriginal) => {
        const original =
          await importOriginal<typeof import("@easyoref/shared")>();
        return {
          ...original,
          getUser: vi.fn().mockResolvedValue({
            chatId: "test_user",
            language: "en",
            areas: ["Tel Aviv"],
            tier: "free",
            registeredAt: 0,
            lastActiveAt: 0,
          }),
          getActiveSession: vi.fn().mockResolvedValue(null),
          getVotedInsights: vi.fn().mockResolvedValue([]),
        };
      });

      const { runQa } = await import("../src/graphs/qa/qa-graph.js");
      const answer = await runQa("help", "test_user");
      expect(answer).toBeTruthy();
      expect(typeof answer).toBe("string");
      expect(answer.length).toBeGreaterThan(5);

      vi.restoreAllMocks();
    },
    15000,
  );
});
