import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock @easyoref/shared ─────────────────────────────────────────────────────

const mockGetUser = vi.fn();
const mockSetUserTier = vi.fn();
const mockGetAllUsers = vi.fn();

vi.mock("@easyoref/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@easyoref/shared")>();
  return {
    ...actual,
    getUser: mockGetUser,
    setUserTier: mockSetUserTier,
    getAllUsers: mockGetAllUsers,
    config: {
      adminChatIds: [111111],
    },
  };
});

vi.mock("@easyoref/shared/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// ── requirePro middleware ─────────────────────────────────────────────────────

describe("requirePro middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls next() for pro user", async () => {
    mockGetUser.mockResolvedValue({ chatId: "123", tier: "pro" });
    const { requirePro } = await import("../middleware/tier.js");
    const ctx = { chat: { id: 123 }, reply: vi.fn() } as any;
    const next = vi.fn();
    await requirePro(ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("replies and stops chain for free user", async () => {
    mockGetUser.mockResolvedValue({ chatId: "123", tier: "free" });
    const { requirePro } = await import("../middleware/tier.js");
    const ctx = { chat: { id: 123 }, reply: vi.fn() } as any;
    const next = vi.fn();
    await requirePro(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(
      "This feature requires Pro tier. Contact the bot admin.",
    );
  });

  it("stops chain for unknown user (not registered)", async () => {
    mockGetUser.mockResolvedValue(undefined);
    const { requirePro } = await import("../middleware/tier.js");
    const ctx = { chat: { id: 999 }, reply: vi.fn() } as any;
    const next = vi.fn();
    await requirePro(ctx, next);
    expect(next).not.toHaveBeenCalled();
  });

  it("does nothing when ctx.chat is missing", async () => {
    const { requirePro } = await import("../middleware/tier.js");
    const ctx = { chat: undefined, reply: vi.fn() } as any;
    const next = vi.fn();
    await requirePro(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});

// ── Admin command handlers ────────────────────────────────────────────────────

describe("admin command handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeCtx(chatId: number, match?: string) {
    return {
      chat: { id: chatId },
      match,
      reply: vi.fn(),
    } as any;
  }

  function makeBot() {
    const handlers: Record<string, (ctx: any) => Promise<void>> = {};
    return {
      command: (cmd: string, fn: (ctx: any) => Promise<void>) => {
        handlers[cmd] = fn;
      },
      trigger: (cmd: string, ctx: any) => handlers[cmd]?.(ctx),
    };
  }

  it("/grant upgrades user to pro (admin)", async () => {
    mockSetUserTier.mockResolvedValue(true);
    const { registerAdminHandler } = await import("../handlers/admin.js");
    const bot = makeBot();
    registerAdminHandler(bot as any);

    const ctx = makeCtx(111111, "222222");
    await bot.trigger("grant", ctx);
    expect(mockSetUserTier).toHaveBeenCalledWith("222222", "pro");
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Pro"));
  });

  it("/grant rejects non-admin", async () => {
    const { registerAdminHandler } = await import("../handlers/admin.js");
    const bot = makeBot();
    registerAdminHandler(bot as any);

    const ctx = makeCtx(999999, "222222");
    await bot.trigger("grant", ctx);
    expect(mockSetUserTier).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("доступа"));
  });

  it("/grant replies not found when user missing", async () => {
    mockSetUserTier.mockResolvedValue(false);
    const { registerAdminHandler } = await import("../handlers/admin.js");
    const bot = makeBot();
    registerAdminHandler(bot as any);

    const ctx = makeCtx(111111, "999");
    await bot.trigger("grant", ctx);
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("999"));
  });

  it("/revoke downgrades user to free (admin)", async () => {
    mockSetUserTier.mockResolvedValue(true);
    const { registerAdminHandler } = await import("../handlers/admin.js");
    const bot = makeBot();
    registerAdminHandler(bot as any);

    const ctx = makeCtx(111111, "222222");
    await bot.trigger("revoke", ctx);
    expect(mockSetUserTier).toHaveBeenCalledWith("222222", "free");
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("Free"));
  });

  it("/revoke rejects non-admin", async () => {
    const { registerAdminHandler } = await import("../handlers/admin.js");
    const bot = makeBot();
    registerAdminHandler(bot as any);

    const ctx = makeCtx(999999, "222222");
    await bot.trigger("revoke", ctx);
    expect(mockSetUserTier).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("доступа"));
  });

  it("/users lists all users (admin)", async () => {
    mockGetAllUsers.mockResolvedValue([
      {
        chatId: "123",
        tier: "pro",
        language: "ru",
        areas: ["תל אביב"],
        registeredAt: 0,
        lastActiveAt: 0,
      },
      {
        chatId: "456",
        tier: "free",
        language: "he",
        areas: ["חיפה"],
        registeredAt: 0,
        lastActiveAt: 0,
      },
    ]);
    const { registerAdminHandler } = await import("../handlers/admin.js");
    const bot = makeBot();
    registerAdminHandler(bot as any);

    const ctx = makeCtx(111111);
    await bot.trigger("users", ctx);
    expect(ctx.reply).toHaveBeenCalledWith(
      expect.stringContaining("Registered Users (2)"),
      { parse_mode: "HTML" },
    );
  });

  it("/users rejects non-admin", async () => {
    const { registerAdminHandler } = await import("../handlers/admin.js");
    const bot = makeBot();
    registerAdminHandler(bot as any);

    const ctx = makeCtx(999999);
    await bot.trigger("users", ctx);
    expect(mockGetAllUsers).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining("доступа"));
  });

  it("/users replies when no users registered", async () => {
    mockGetAllUsers.mockResolvedValue([]);
    const { registerAdminHandler } = await import("../handlers/admin.js");
    const bot = makeBot();
    registerAdminHandler(bot as any);

    const ctx = makeCtx(111111);
    await bot.trigger("users", ctx);
    expect(ctx.reply).toHaveBeenCalledWith("No registered users.");
  });
});
