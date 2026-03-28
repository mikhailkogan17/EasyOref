/**
 * Unit tests for edit-node helpers.
 *
 * Covers: sendMetaReply — silent metadata reply logic.
 * All Telegram API calls are mocked. No network, no LLM.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SynthesizedInsightType } from "@easyoref/shared";

// ── Mocks ──────────────────────────────────────────────────

const { mockSendMessage, mockGetActiveSession, mockSetActiveSession } = vi.hoisted(() => ({
  mockSendMessage: vi.fn().mockResolvedValue({ message_id: 999 }),
  mockGetActiveSession: vi.fn(),
  mockSetActiveSession: vi.fn(),
}));

// Mock grammy Bot
vi.mock("grammy", () => ({
  Bot: vi.fn().mockImplementation(() => ({
    api: { sendMessage: mockSendMessage },
  })),
}));

vi.mock("@easyoref/shared", async () => {
  const actual = await vi.importActual("@easyoref/shared");
  return {
    ...actual,
    config: {
      botToken: "test-bot-token",
      language: "ru",
      agent: { mcpTools: false },
    },
    getActiveSession: mockGetActiveSession,
    setActiveSession: mockSetActiveSession,
    getLanguagePack: (actual as any).getLanguagePack,
  };
});

vi.mock("@easyoref/monitoring", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// ── Imports (after mocks) ──────────────────────────────────

import { sendMetaReply } from "../src/nodes/edit-node.js";
import type { TelegramTargetMessage } from "../src/nodes/edit-node.js";

// ── Helpers ────────────────────────────────────────────────

function makeInsights(
  entries: Array<{ key: string; value: string }>,
): SynthesizedInsightType[] {
  return entries.map((e) => ({
    key: e.key,
    value: e.value,
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

  it("does nothing when rocket_count is missing", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    await sendMetaReply(
      "early_warning",
      makeInsights([{ key: "eta_absolute", value: "~14:30" }]),
      [defaultTarget],
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it("does nothing when eta_absolute is missing", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    await sendMetaReply(
      "early_warning",
      makeInsights([{ key: "rocket_count", value: "10" }]),
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
    mockGetActiveSession.mockResolvedValue(makeSession({ metaMessageSent: true }));
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

  it("appends cassette suffix when is_cassette=true", async () => {
    mockGetActiveSession.mockResolvedValue(makeSession());
    await sendMetaReply(
      "early_warning",
      makeInsights([
        { key: "rocket_count", value: "20" },
        { key: "eta_absolute", value: "~14:45" },
        { key: "is_cassette", value: "true" },
      ]),
      [defaultTarget],
    );
    const text = mockSendMessage.mock.calls[0][1] as string;
    expect(text).toContain(", кассетные");
  });

  it("does NOT append cassette suffix when is_cassette is absent", async () => {
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
    // Temporarily override config.language to "he" by re-mocking
    const { config } = await import("@easyoref/shared");
    const original = (config as any).language;
    (config as any).language = "he";

    mockGetActiveSession.mockResolvedValue(makeSession());
    await sendMetaReply(
      "early_warning",
      makeInsights([
        { key: "rocket_count", value: "7" },
        { key: "eta_absolute", value: "~17:00" },
      ]),
      [defaultTarget],
    );

    (config as any).language = original;

    const text = mockSendMessage.mock.calls[0][1] as string;
    expect(text).toContain("טילים");   // Hebrew "rockets"
    expect(text).toContain("הגעה");    // Hebrew "arrival"
  });
});
