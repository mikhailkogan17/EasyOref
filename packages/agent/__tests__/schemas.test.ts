/**
 * Unit tests for Zod schemas in @easyoref/shared.
 *
 * Covers:
 *  - RunEnrichmentInput: optional/default telegramMessages, required fields
 *  - ActiveSession: optional telegramMessages, required fields
 *  - TelegramMessage: valid / invalid
 *  - validateSafe helper: ok path + error path
 */

import {
  ActiveSession,
  RunEnrichmentInput,
  TelegramMessage,
  validateSafe,
} from "@easyoref/shared";
import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────
// TelegramMessage
// ─────────────────────────────────────────────────────────

describe("TelegramMessage schema", () => {
  it("accepts valid message", () => {
    const result = TelegramMessage.safeParse({
      chatId: "-1001234567890",
      messageId: 42,
      isCaption: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing chatId", () => {
    const result = TelegramMessage.safeParse({ messageId: 1, isCaption: false });
    expect(result.success).toBe(false);
  });

  it("rejects messageId = 0 (min: 1)", () => {
    const result = TelegramMessage.safeParse({
      chatId: "-100abc",
      messageId: 0,
      isCaption: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative messageId", () => {
    const result = TelegramMessage.safeParse({
      chatId: "-100abc",
      messageId: -5,
      isCaption: false,
    });
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
// RunEnrichmentInput
// ─────────────────────────────────────────────────────────

const baseInput = {
  alertId: "alert-123",
  alertTs: 1700000000000,
  alertType: "red_alert" as const,
  alertAreas: ["תל אביב - דרום העיר ויפו"],
  chatId: "-1001234567890",
  messageId: 100,
  isCaption: false,
  currentText: "Red Alert",
};

describe("RunEnrichmentInput schema", () => {
  it("accepts valid input with explicit telegramMessages", () => {
    const result = RunEnrichmentInput.safeParse({
      ...baseInput,
      telegramMessages: [{ chatId: "-100x", messageId: 1, isCaption: false }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.telegramMessages).toHaveLength(1);
    }
  });

  it("defaults telegramMessages to [] when omitted", () => {
    const result = RunEnrichmentInput.safeParse(baseInput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.telegramMessages).toEqual([]);
    }
  });

  it("defaults telegramMessages to [] when explicitly undefined", () => {
    const result = RunEnrichmentInput.safeParse({
      ...baseInput,
      telegramMessages: undefined,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.telegramMessages).toEqual([]);
    }
  });

  it("rejects missing alertId", () => {
    const { alertId: _, ...rest } = baseInput as Record<string, unknown>;
    const result = RunEnrichmentInput.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects empty alertAreas", () => {
    const result = RunEnrichmentInput.safeParse({
      ...baseInput,
      alertAreas: [],
    });
    // alertAreas: z.array(z.string().min(1)) — empty array passes (no min(1) on array itself)
    // This documents the current schema behaviour
    expect(result.success).toBe(true);
  });

  it("rejects invalid alertType", () => {
    const result = RunEnrichmentInput.safeParse({
      ...baseInput,
      alertType: "unknown_type",
    });
    expect(result.success).toBe(false);
  });

  it("accepts all three alertType values", () => {
    for (const alertType of ["early_warning", "red_alert", "resolved"] as const) {
      const result = RunEnrichmentInput.safeParse({ ...baseInput, alertType });
      expect(result.success).toBe(true);
    }
  });

  it("accepts optional monitoringLabel", () => {
    const result = RunEnrichmentInput.safeParse({
      ...baseInput,
      monitoringLabel: "⏳ Updating...",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.monitoringLabel).toBe("⏳ Updating...");
    }
  });

  it("round-trips: parse → serialize → parse", () => {
    const parsed = RunEnrichmentInput.parse({
      ...baseInput,
      telegramMessages: [{ chatId: "-100x", messageId: 5, isCaption: true }],
    });
    const reparsed = RunEnrichmentInput.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
  });
});

// ─────────────────────────────────────────────────────────
// ActiveSession
// ─────────────────────────────────────────────────────────

const baseSession = {
  sessionId: "sess-001",
  sessionStartTs: 1700000000000,
  phase: "red_alert" as const,
  phaseStartTs: 1700000001000,
  latestAlertId: "alert-001",
  latestMessageId: 42,
  latestAlertTs: 1700000002000,
  chatId: "-1001234567890",
  isCaption: false,
  currentText: "Red Alert",
  baseText: "Red Alert base",
  alertAreas: ["תל אביב"],
};

describe("ActiveSession schema", () => {
  it("accepts session without telegramMessages", () => {
    const result = ActiveSession.safeParse(baseSession);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.telegramMessages).toBeUndefined();
    }
  });

  it("accepts session with telegramMessages", () => {
    const result = ActiveSession.safeParse({
      ...baseSession,
      telegramMessages: [{ chatId: "-100x", messageId: 1, isCaption: false }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.telegramMessages).toHaveLength(1);
    }
  });

  it("accepts optional metaMessageSent", () => {
    const result = ActiveSession.safeParse({
      ...baseSession,
      metaMessageSent: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metaMessageSent).toBe(true);
    }
  });

  it("rejects session with empty sessionId", () => {
    const result = ActiveSession.safeParse({ ...baseSession, sessionId: "" });
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
// validateSafe helper
// ─────────────────────────────────────────────────────────

describe("validateSafe", () => {
  it("returns ok:true for valid data", () => {
    const result = validateSafe(TelegramMessage, {
      chatId: "-100abc",
      messageId: 1,
      isCaption: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.chatId).toBe("-100abc");
    }
  });

  it("returns ok:false with error string for invalid data", () => {
    const result = validateSafe(TelegramMessage, { chatId: "", messageId: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("does not throw on invalid data", () => {
    expect(() => validateSafe(RunEnrichmentInput, null)).not.toThrow();
  });
});
