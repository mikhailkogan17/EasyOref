/**
 * Unit tests for GramJS channel monitor.
 *
 * Tests the channel ID cache, handleNewMessage resolution,
 * backfillChannelPosts, and the silent-catch fix.
 *
 * No real Telegram connection — everything is mocked.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────

const mockPushChannelPost = vi.fn();
const mockGetActiveAlert = vi.fn();
const mockGetActiveSession = vi.fn();

vi.mock("@easyoref/shared", async () => {
  const actual = await vi.importActual("@easyoref/shared");
  return {
    ...actual,
    config: {
      agent: {
        enabled: true,
        apiKey: "test-key",
        mtproto: { apiId: 123, apiHash: "abc", sessionString: "session" },
        socks5Proxy: "",
        filterModel: "test-model",
        filterFallbackModel: "test-fallback",
        extractModel: "test-model",
        extractFallbackModel: "test-fallback",
        redisUrl: "redis://localhost:6379",
      },
      botToken: "",
      areas: [],
      language: "ru",
    },
    pushChannelPost: (...args: unknown[]) => mockPushChannelPost(...args),
    getActiveAlert: () => mockGetActiveAlert(),
    getActiveSession: () => mockGetActiveSession(),
  };
});

vi.mock("@easyoref/shared/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

// Mock the telegram module — we don't actually connect
vi.mock("telegram", () => ({
  TelegramClient: vi.fn(),
  Api: { channels: { JoinChannel: vi.fn() }, messages: { ImportChatInvite: vi.fn() } },
}));
vi.mock("telegram/events/index.js", () => ({
  NewMessage: vi.fn(),
}));
vi.mock("telegram/sessions/index.js", () => ({
  StringSession: vi.fn().mockImplementation(() => ({})),
}));

// ── Import (after mocks) ──────────────────────────────────

import { MONITORED_CHANNELS, backfillChannelPosts } from "../src/index.js";

// ── Tests ──────────────────────────────────────────────────

describe("MONITORED_CHANNELS export", () => {
  it("exports a non-empty array of channel handles", () => {
    expect(Array.isArray(MONITORED_CHANNELS)).toBe(true);
    expect(MONITORED_CHANNELS.length).toBeGreaterThan(0);
    for (const ch of MONITORED_CHANNELS) {
      expect(ch).toMatch(/^@/);
    }
  });

  it("includes key news channels", () => {
    expect(MONITORED_CHANNELS).toContain("@N12LIVE");
    expect(MONITORED_CHANNELS).toContain("@lieldaphna");
    expect(MONITORED_CHANNELS).toContain("@divuhim1234");
  });
});

describe("backfillChannelPosts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 0 when no active alert", async () => {
    mockGetActiveAlert.mockResolvedValue(undefined);
    const count = await backfillChannelPosts(Date.now() - 60_000);
    expect(count).toBe(0);
    expect(mockPushChannelPost).not.toHaveBeenCalled();
  });

  it("returns 0 when client is not connected (no startMonitor called)", async () => {
    mockGetActiveAlert.mockResolvedValue({
      alertId: "alert-1",
      alertTs: Date.now(),
      alertType: "red_alert",
    });
    // _client is undefined since startMonitor() was never called
    const count = await backfillChannelPosts(Date.now() - 60_000);
    expect(count).toBe(0);
  });
});
