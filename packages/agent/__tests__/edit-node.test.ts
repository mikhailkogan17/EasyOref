/**
 * Unit tests for edit-node — two enrichment messages (launch info + analysis).
 *
 * Covers: sendOrUpdateLaunchInfo, sendOrUpdateAnalysis, editNode.
 * All Telegram API calls are mocked. No network, no LLM.
 */

import type { SynthesizedInsightType } from "@easyoref/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──────────────────────────────────────────────────

const {
  mockSendMessage,
  mockEditMessageText,
  mockGetActiveSession,
  mockSetActiveSession,
  mockSaveSynthesizedInsights,
} = vi.hoisted(() => ({
  mockSendMessage: vi.fn().mockResolvedValue({ message_id: 999 }),
  mockEditMessageText: vi.fn().mockResolvedValue(true),
  mockGetActiveSession: vi.fn(),
  mockSetActiveSession: vi.fn(),
  mockSaveSynthesizedInsights: vi.fn().mockResolvedValue(undefined),
}));

// Mock grammy Bot
vi.mock("grammy", () => ({
  Bot: vi.fn().mockImplementation(() => ({
    api: {
      sendMessage: mockSendMessage,
      editMessageText: mockEditMessageText,
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
    saveSynthesizedInsights: mockSaveSynthesizedInsights,
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

import type { TelegramTargetMessage } from "../src/graphs/enrichment/nodes/edit.js";
import {
  editNode,
  sendOrUpdateAnalysis,
  sendOrUpdateLaunchInfo,
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
    ...overrides,
  };
}

const defaultTarget: TelegramTargetMessage = {
  chatId: "-1001234567890",
  messageId: 100,
  isCaption: false,
};

// ─────────────────────────────────────────────────────────
// sendOrUpdateLaunchInfo
// ─────────────────────────────────────────────────────────

describe("sendOrUpdateLaunchInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetActiveSession.mockResolvedValue(undefined);
  });

  it("sends launch info with ETA and rockets (ru)", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    await sendOrUpdateLaunchInfo(
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
    expect(opts.reply_parameters.message_id).toBe(defaultTarget.messageId);
    expect(opts.parse_mode).toBe("HTML");
  });

  it("sends when only eta_absolute is present", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    await sendOrUpdateLaunchInfo(
      makeInsights([{ key: "eta_absolute", value: "~14:30" }]),
      [defaultTarget],
    );
    expect(mockSendMessage).toHaveBeenCalledOnce();
    const text = mockSendMessage.mock.calls[0][1] as string;
    expect(text).toContain("Прилёт: ~14:30");
  });

  it("sends when only origin is present", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    await sendOrUpdateLaunchInfo(
      makeInsights([{ key: "origin", value: "Ливан" }]),
      [defaultTarget],
    );
    expect(mockSendMessage).toHaveBeenCalledOnce();
    expect(mockSendMessage.mock.calls[0][1]).toContain("Ливан");
  });

  it("includes origin in parentheses when rocket_count also present", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    await sendOrUpdateLaunchInfo(
      makeInsights([
        { key: "rocket_count", value: "5" },
        { key: "origin", value: "Иран" },
      ]),
      [defaultTarget],
    );
    const text = mockSendMessage.mock.calls[0][1] as string;
    expect(text).toContain("Ракет (Иран): 5");
  });

  it("renders cluster munition as separate line with да/нет", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    await sendOrUpdateLaunchInfo(
      makeInsights([
        { key: "rocket_count", value: "20" },
        { key: "is_cluster_munition", value: "true" },
      ]),
      [defaultTarget],
    );
    const text = mockSendMessage.mock.calls[0][1] as string;
    expect(text).toContain("Кассетные: да");
    expect(text).not.toContain("Ракет: 20, кассетные");
  });

  it("does nothing when no launch insights", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    await sendOrUpdateLaunchInfo(
      makeInsights([{ key: "intercepted", value: "8" }]),
      [defaultTarget],
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("does nothing when session is null", async () => {
    mockGetActiveSession.mockResolvedValue(null);
    await sendOrUpdateLaunchInfo(
      makeInsights([{ key: "rocket_count", value: "10" }]),
      [defaultTarget],
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("sends to ALL targets including free tier", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    const freeTarget: TelegramTargetMessage = {
      chatId: "-100free",
      messageId: 50,
      isCaption: false,
      tier: "free",
    };
    const proTarget: TelegramTargetMessage = {
      chatId: "-100pro",
      messageId: 60,
      isCaption: false,
    };
    await sendOrUpdateLaunchInfo(
      makeInsights([
        { key: "rocket_count", value: "3" },
        { key: "origin", value: "Ливан" },
      ]),
      [freeTarget, proTarget],
    );
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it("edits existing launch message on subsequent runs", async () => {
    mockGetActiveSession.mockResolvedValue(
      makeSession({ launchMessageIds: { "-1001234567890": 500 } }),
    );
    await sendOrUpdateLaunchInfo(
      makeInsights([{ key: "rocket_count", value: "15" }]),
      [defaultTarget],
    );
    // Should edit, not send new
    expect(mockEditMessageText).toHaveBeenCalledOnce();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockEditMessageText.mock.calls[0][0]).toBe("-1001234567890");
    expect(mockEditMessageText.mock.calls[0][1]).toBe(500);
  });

  it("persists launchMessageIds to session", async () => {
    const session = makeSession();
    mockGetActiveSession.mockResolvedValue(session);
    await sendOrUpdateLaunchInfo(
      makeInsights([{ key: "rocket_count", value: "8" }]),
      [defaultTarget],
    );
    expect(mockSetActiveSession).toHaveBeenCalledOnce();
    const saved = mockSetActiveSession.mock.calls[0][0];
    expect(saved.launchMessageIds["-1001234567890"]).toBe(999);
  });

  it("uses Hebrew labels when language is he", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    const heTarget: TelegramTargetMessage = {
      ...defaultTarget,
      language: "he",
    };
    await sendOrUpdateLaunchInfo(
      makeInsights([
        { key: "rocket_count", value: "7" },
        { key: "eta_absolute", value: "~17:00" },
      ]),
      [heTarget],
    );
    const text = mockSendMessage.mock.calls[0][1] as string;
    expect(text).toContain("טילים");
    expect(text).toContain("פגיעה משוערת");
  });
});

// ─────────────────────────────────────────────────────────
// sendOrUpdateAnalysis
// ─────────────────────────────────────────────────────────

describe("sendOrUpdateAnalysis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetActiveSession.mockResolvedValue(undefined);
  });

  it("sends analysis with intercepted and hits (ru)", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    await sendOrUpdateAnalysis(
      makeInsights([
        { key: "intercepted", value: "8" },
        { key: "hits", value: "Рамат-Ган" },
      ]),
      [defaultTarget],
    );
    expect(mockSendMessage).toHaveBeenCalledOnce();
    const text = mockSendMessage.mock.calls[0][1] as string;
    expect(text).toContain("Перехваты: 8");
    expect(text).toContain("Попадания: Рамат-Ган");
  });

  it("sends only to pro targets (not free)", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    const freeTarget: TelegramTargetMessage = {
      chatId: "-100free",
      messageId: 50,
      isCaption: false,
      tier: "free",
    };
    const proTarget: TelegramTargetMessage = {
      chatId: "-100pro",
      messageId: 60,
      isCaption: false,
    };
    await sendOrUpdateAnalysis(
      makeInsights([{ key: "intercepted", value: "8" }]),
      [freeTarget, proTarget],
    );
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0][0]).toBe("-100pro");
  });

  it("does nothing when only free targets", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    const freeTarget: TelegramTargetMessage = {
      chatId: "-100free",
      messageId: 50,
      isCaption: false,
      tier: "free",
    };
    await sendOrUpdateAnalysis(
      makeInsights([{ key: "intercepted", value: "8" }]),
      [freeTarget],
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("does nothing when no analysis insights", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    await sendOrUpdateAnalysis(
      makeInsights([{ key: "rocket_count", value: "10" }]),
      [defaultTarget],
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("edits existing analysis message on subsequent runs", async () => {
    mockGetActiveSession.mockResolvedValue(
      makeSession({ analysisMessageIds: { "-1001234567890": 600 } }),
    );
    await sendOrUpdateAnalysis(
      makeInsights([{ key: "intercepted", value: "12" }]),
      [defaultTarget],
    );
    expect(mockEditMessageText).toHaveBeenCalledOnce();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("shows no_casualties=none as нет", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    await sendOrUpdateAnalysis(
      makeInsights([{ key: "no_casualties", value: "none" }]),
      [defaultTarget],
    );
    const text = mockSendMessage.mock.calls[0][1] as string;
    expect(text).toContain("Пострадавшие: нет");
  });
});

// ─────────────────────────────────────────────────────────
// editNode
// ─────────────────────────────────────────────────────────

describe("editNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetActiveSession.mockResolvedValue(undefined);
    mockGetActiveSession.mockResolvedValue(makeSession());
  });

  it("does NOT crash when state.synthesizedInsights is undefined", async () => {
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

    const result = await editNode(state as any);
    expect(result).toBeDefined();
    expect(result.messages).toHaveLength(1);
    const msgContent = JSON.parse(result.messages![0].content as string);
    expect(msgContent.synthesizedKeys).toEqual([]);
  });

  it("sends launch message for launch insights, no oref edit", async () => {
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
        { key: "eta_absolute", value: "~7 min" },
      ]),
      extractedInsights: [],
      filteredInsights: [],
      previousInsights: [],
      telegramMessages: [defaultTarget],
    };

    await editNode(state as any);

    // Launch message sent as new reply
    expect(mockSendMessage).toHaveBeenCalledOnce();
    const text = mockSendMessage.mock.calls[0][1] as string;
    expect(text).toContain("Ракет (Иран): 10");
    expect(text).toContain("Прилёт: ~7 min");
  });

  it("sends both launch and analysis messages for mixed insights", async () => {
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
      synthesizedInsights: makeInsights([
        { key: "origin", value: "Иран" },
        { key: "rocket_count", value: "10" },
        { key: "intercepted", value: "8" },
      ]),
      extractedInsights: [],
      filteredInsights: [],
      previousInsights: [],
      telegramMessages: [defaultTarget],
    };

    await editNode(state as any);

    // Two sendMessage calls: one for launch, one for analysis
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
  });

  it("skips canary alerts", async () => {
    const state = {
      messages: [],
      alertId: "canary-test-1",
      alertTs: Date.now(),
      alertType: "red_alert" as const,
      alertAreas: ["תל אביב"],
      chatId: "-1001234567890",
      messageId: 100,
      isCaption: false,
      currentText: "🔴 Red Alert",
      votedResult: undefined,
      synthesizedInsights: makeInsights([{ key: "rocket_count", value: "10" }]),
      extractedInsights: [],
      filteredInsights: [],
      previousInsights: [],
      telegramMessages: [defaultTarget],
    };

    const result = await editNode(state as any);
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(result.messages).toHaveLength(1);
  });
});
