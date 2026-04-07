/**
 * Unit tests for edit-node helpers.
 *
 * Covers: sendMetaReply — silent metadata reply logic.
 * All Telegram API calls are mocked. No network, no LLM.
 */

import type { SynthesizedInsightType } from "@easyoref/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────

const {
  mockSendMessage,
  mockEditMessageText,
  mockEditMessageCaption,
  mockGetActiveSession,
  mockSetActiveSession,
} = vi.hoisted(() => ({
  mockSendMessage: vi.fn().mockResolvedValue({ message_id: 999 }),
  mockEditMessageText: vi.fn().mockResolvedValue(true),
  mockEditMessageCaption: vi.fn().mockResolvedValue(true),
  mockGetActiveSession: vi.fn(),
  mockSetActiveSession: vi.fn(),
}));

// Mock grammy Bot
vi.mock("grammy", () => ({
  Bot: vi.fn().mockImplementation(() => ({
    api: {
      sendMessage: mockSendMessage,
      editMessageText: mockEditMessageText,
      editMessageCaption: mockEditMessageCaption,
    },
  })),
}));

vi.mock("@easyoref/shared", async () => {
  const actual = await vi.importActual("@easyoref/shared");
  return {
    ...actual,
    config: {
      botToken: "test-bot-token",
      agent: {},
    },
    getActiveSession: mockGetActiveSession,
    setActiveSession: mockSetActiveSession,
    getLanguagePack: (actual as any).getLanguagePack,
  };
});

vi.mock("@easyoref/shared/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// ── Imports (after mocks) ──────────────────────────────────

import type {
  EditMessageInput,
  TelegramTargetMessage,
} from "../src/graphs/enrichment/nodes/edit.js";
import {
  editNode,
  editTelegramMessage,
  sendMetaReply,
} from "../src/graphs/enrichment/nodes/edit.js";

// ── Helpers ────────────────────────────────────────────────

function makeInsights(
  entries: Array<{
    key: string;
    value: string;
    valueLang?: Partial<Record<"ru" | "en" | "he" | "ar", string>>;
  }>,
): SynthesizedInsightType[] {
  return entries.map((e) => ({
    key: e.key,
    value: e.valueLang
      ? { ru: e.value, en: e.value, he: e.value, ar: e.value, ...e.valueLang }
      : { ru: e.value, en: e.value, he: e.value, ar: e.value },
    confidence: 0.9,
    sourceUrls: [],
  }));
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "sess-1",
    sessionStartTs: Date.now(),
    phase: "early_warning" as const,
    phaseStartTs: Date.now(),
    latestAlertId: "alert-1",
    latestMessageId: 100,
    latestAlertTs: Date.now(),
    chatId: "-1001234567890",
    isCaption: false,
    currentText: "text",
    baseText: "text",
    alertAreas: ["תל אביב"],
    metaMessageSent: false,
    ...overrides,
  };
}

const defaultTarget: TelegramTargetMessage = {
  chatId: "-1001234567890",
  messageId: 100,
  isCaption: false,
};

// ─────────────────────────────────────────────────────────
// sendMetaReply
// ─────────────────────────────────────────────────────────

describe("sendMetaReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetActiveSession.mockResolvedValue(undefined);
  });

  it("does nothing when alertType is not early_warning", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    await sendMetaReply(
      "red_alert",
      makeInsights([
        { key: "rocket_count", value: "10" },
        { key: "eta_absolute", value: "~14:30" },
      ]),
      [defaultTarget],
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("sends when only eta_absolute is present (no rocket_count)", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    await sendMetaReply(
      "early_warning",
      makeInsights([{ key: "eta_absolute", value: "~14:30" }]),
      [defaultTarget],
    );
    expect(mockSendMessage).toHaveBeenCalledOnce();
    const text = mockSendMessage.mock.calls[0][1] as string;
    expect(text).toContain("Прилёт: ~14:30");
  });

  it("sends when only rocket_count is present (no eta_absolute)", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    await sendMetaReply(
      "early_warning",
      makeInsights([{ key: "rocket_count", value: "10" }]),
      [defaultTarget],
    );
    expect(mockSendMessage).toHaveBeenCalledOnce();
    const text = mockSendMessage.mock.calls[0][1] as string;
    expect(text).toContain("Ракет: 10");
  });

  it("does nothing when neither rocket_count nor eta_absolute is present (only origin)", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    await sendMetaReply(
      "early_warning",
      makeInsights([{ key: "origin", value: "Иран" }]),
      [defaultTarget],
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("does nothing when session is null", async () => {
    mockGetActiveSession.mockResolvedValue(null);
    await sendMetaReply(
      "early_warning",
      makeInsights([
        { key: "rocket_count", value: "10" },
        { key: "eta_absolute", value: "~14:30" },
      ]),
      [defaultTarget],
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("does nothing when metaMessageSent is already true", async () => {
    mockGetActiveSession.mockResolvedValue(
      makeSession({ metaMessageSent: true }),
    );
    await sendMetaReply(
      "early_warning",
      makeInsights([
        { key: "rocket_count", value: "10" },
        { key: "eta_absolute", value: "~14:30" },
      ]),
      [defaultTarget],
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("sends silent reply with rocket count and ETA (ru)", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    await sendMetaReply(
      "early_warning",
      makeInsights([
        { key: "rocket_count", value: "12" },
        { key: "eta_absolute", value: "~14:23" },
      ]),
      [defaultTarget],
    );
    expect(mockSendMessage).toHaveBeenCalledOnce();
    const [chatId, text, opts] = mockSendMessage.mock.calls[0];
    expect(chatId).toBe(defaultTarget.chatId);
    expect(text).toContain("Ракет: 12");
    expect(text).toContain("Прилёт: ~14:23");
    expect(opts.disable_notification).toBe(true);
    expect(opts.reply_to_message_id).toBe(defaultTarget.messageId);
    expect(opts.parse_mode).toBe("HTML");
  });

  it("includes origin in parentheses when present", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    await sendMetaReply(
      "early_warning",
      makeInsights([
        { key: "rocket_count", value: "5" },
        { key: "eta_absolute", value: "~14:30" },
        { key: "origin", value: "Иран" },
      ]),
      [defaultTarget],
    );
    const text = mockSendMessage.mock.calls[0][1] as string;
    expect(text).toContain("Ракет (Иран): 5");
  });

  it("omits origin parentheses when origin is absent", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    await sendMetaReply(
      "early_warning",
      makeInsights([
        { key: "rocket_count", value: "5" },
        { key: "eta_absolute", value: "~14:30" },
      ]),
      [defaultTarget],
    );
    const text = mockSendMessage.mock.calls[0][1] as string;
    expect(text).not.toContain("(");
    expect(text).toContain("Ракет: 5");
  });

  it("appends cluster munition suffix when is_cluster_munition=true", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    await sendMetaReply(
      "early_warning",
      makeInsights([
        { key: "rocket_count", value: "20" },
        { key: "eta_absolute", value: "~14:45" },
        { key: "is_cluster_munition", value: "true" },
      ]),
      [defaultTarget],
    );
    const text = mockSendMessage.mock.calls[0][1] as string;
    expect(text).toContain(", кассетные");
  });

  it("does NOT append cluster munition suffix when is_cluster_munition is absent", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    await sendMetaReply(
      "early_warning",
      makeInsights([
        { key: "rocket_count", value: "20" },
        { key: "eta_absolute", value: "~14:45" },
      ]),
      [defaultTarget],
    );
    const text = mockSendMessage.mock.calls[0][1] as string;
    expect(text).not.toContain("кассетные");
  });

  it("marks session.metaMessageSent=true after sending", async () => {
    const session = makeSession();
    mockGetActiveSession.mockResolvedValue(session);
    await sendMetaReply(
      "early_warning",
      makeInsights([
        { key: "rocket_count", value: "8" },
        { key: "eta_absolute", value: "~15:00" },
      ]),
      [defaultTarget],
    );
    expect(mockSetActiveSession).toHaveBeenCalledOnce();
    const savedSession = mockSetActiveSession.mock.calls[0][0];
    expect(savedSession.metaMessageSent).toBe(true);
  });

  it("sends to multiple targets", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    const targets: TelegramTargetMessage[] = [
      { chatId: "-100111", messageId: 10, isCaption: false },
      { chatId: "-100222", messageId: 20, isCaption: false },
    ];
    await sendMetaReply(
      "early_warning",
      makeInsights([
        { key: "rocket_count", value: "3" },
        { key: "eta_absolute", value: "~16:00" },
      ]),
      targets,
    );
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    expect(mockSendMessage.mock.calls[0][0]).toBe("-100111");
    expect(mockSendMessage.mock.calls[1][0]).toBe("-100222");
  });

  it("uses Hebrew labels when language is he", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    const heTarget: TelegramTargetMessage = {
      ...defaultTarget,
      language: "he" as const,
    };
    await sendMetaReply(
      "early_warning",
      makeInsights([
        { key: "rocket_count", value: "7" },
        { key: "eta_absolute", value: "~17:00" },
      ]),
      [heTarget],
    );

    const text = mockSendMessage.mock.calls[0][1] as string;
    expect(text).toContain("טילים"); // Hebrew "rockets"
    expect(text).toContain("פגיעה משוערת"); // Hebrew "expected impact"
  });
});

// ─────────────────────────────────────────────────────────
// editTelegramMessage — undefined synthesizedInsights guard
// ─────────────────────────────────────────────────────────

describe("editTelegramMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetActiveSession.mockResolvedValue(undefined);
    mockGetActiveSession.mockResolvedValue(makeSession());
  });

  const baseInput: EditMessageInput = {
    alertId: "alert-1",
    alertTs: Date.now(),
    alertType: "red_alert",
    chatId: "-1001234567890",
    messageId: 100,
    isCaption: false,
    currentText: "🔴 Red Alert: Tel Aviv",
    votedResult: undefined,
    synthesizedInsights: [],
  };

  it("does NOT crash when synthesizedInsights is undefined (production bug)", async () => {
    // This is the exact scenario that crashed in production on 2026-03-29:
    // synthesize-node returned early without setting synthesizedInsights,
    // so ReducedValue never fired and state.synthesizedInsights was undefined.
    const input = {
      ...baseInput,
      synthesizedInsights: undefined as unknown as SynthesizedInsightType[],
    };

    // Should NOT throw — the ?? [] guard handles it
    await expect(editTelegramMessage(input)).resolves.not.toThrow();
  });

  it("returns early when insights array is empty (no useful content)", async () => {
    await editTelegramMessage(baseInput);

    // No edits should be made — empty insights means hasContent is false
    expect(mockEditMessageText).not.toHaveBeenCalled();
    expect(mockEditMessageCaption).not.toHaveBeenCalled();
  });

  it("edits message when insights contain useful content", async () => {
    const input: EditMessageInput = {
      ...baseInput,
      synthesizedInsights: makeInsights([
        { key: "origin", value: "Iran" },
        { key: "rocket_count", value: "10" },
      ]),
    };

    await editTelegramMessage(input);

    expect(mockEditMessageText).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────
// editNode — undefined state.synthesizedInsights guard
// ─────────────────────────────────────────────────────────

describe("editNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetActiveSession.mockResolvedValue(undefined);
    mockGetActiveSession.mockResolvedValue(makeSession());
  });

  it("does NOT crash when state.synthesizedInsights is undefined (production bug)", async () => {
    // Minimal AgentStateType-like object with undefined synthesizedInsights
    const state = {
      messages: [],
      alertId: "alert-1",
      alertTs: Date.now(),
      alertType: "red_alert" as const,
      alertAreas: ["תל אביב"],
      chatId: "-1001234567890",
      messageId: 100,
      isCaption: false,
      currentText: "🔴 Red Alert",
      votedResult: undefined,
      synthesizedInsights: undefined as unknown as SynthesizedInsightType[],
      extractedInsights: [],
      filteredInsights: [],
      previousInsights: [],
      telegramMessages: [],
    };

    // Should NOT throw — the ?? [] guard handles it
    const result = await editNode(state as any);
    expect(result).toBeDefined();
    expect(result.messages).toHaveLength(1);

    // The AIMessage should contain synthesizedKeys: [] since insights were empty
    const msgContent = JSON.parse(result.messages![0].content as string);
    expect(msgContent.synthesizedKeys).toEqual([]);
  });

  it("does NOT edit early_warning messages inline — only meta reply sends metadata", async () => {
    const state = {
      messages: [],
      alertId: "alert-1",
      alertTs: Date.now(),
      alertType: "early_warning" as const,
      alertAreas: ["תל אביב"],
      chatId: "-1001234567890",
      messageId: 100,
      isCaption: false,
      currentText: "⚠️ Early warning",
      votedResult: undefined,
      synthesizedInsights: makeInsights([
        { key: "origin", value: "Иран" },
        { key: "rocket_count", value: "10" },
        { key: "eta_absolute", value: "~14:30" },
      ]),

      extractedInsights: [],
      filteredInsights: [],
      previousInsights: [],
      telegramMessages: undefined,
    };

    await editNode(state as any);

    // editMessageText should NOT be called for early_warning
    expect(mockEditMessageText).not.toHaveBeenCalled();
    expect(mockEditMessageCaption).not.toHaveBeenCalled();

    // BUT sendMessage (meta reply) SHOULD be called
    expect(mockSendMessage).toHaveBeenCalledOnce();
  });

  it("DOES edit red_alert messages inline with enrichment", async () => {
    const state = {
      messages: [],
      alertId: "alert-1",
      alertTs: Date.now(),
      alertType: "red_alert" as const,
      alertAreas: ["תל אביב"],
      chatId: "-1001234567890",
      messageId: 100,
      isCaption: false,
      currentText: "🔴 Red Alert: Tel Aviv",
      votedResult: undefined,
      synthesizedInsights: makeInsights([
        { key: "origin", value: "Иран" },
        { key: "rocket_count", value: "10" },
      ]),
      extractedInsights: [],
      filteredInsights: [],
      previousInsights: [],
      telegramMessages: undefined,
    };

    await editNode(state as any);

    // editMessageText SHOULD be called for red_alert
    expect(mockEditMessageText).toHaveBeenCalledOnce();
    // sendMessage (meta reply) should NOT be called — not early_warning
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});
