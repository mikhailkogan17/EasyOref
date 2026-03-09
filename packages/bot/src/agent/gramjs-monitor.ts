/**
 * GramJS MTProto channel monitor.
 *
 * Connects to Telegram as a user account (burner), joins/monitors
 * the configured public channels, and stores new messages in Redis
 * when there's an active alert window.
 *
 * Rate-limited: 1-2s/channel with ±500ms jitter to avoid bans.
 * Uses exponential backoff on flood errors.
 */

import { Api, TelegramClient } from "telegram";
import { NewMessage } from "telegram/events/index.js";
import type { NewMessageEvent } from "telegram/events/NewMessage.js";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "../config.js";
import * as logger from "../logger.js";
import { getActiveAlert, pushChannelPost } from "./store.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyOpts = Record<string, any>;

let _client: TelegramClient | null = null;

// ── Monitored channels (hardcoded) ────────────────────

const MONITORED_CHANNELS = [
  // Original 5 channels
  "@newsflashhhj",
  "@yediotnews25",
  "@Trueisrael",
  "@israelsecurity",
  "@N12LIVE",
  // New channels added 2026-03-07
  "@moriahdoron",
  "@divuhim1234",
  "@GLOBAL_Telegram_MOKED",
  "@pkpoi",
  "@lieldaphna",
  "@News_cabinet_news",
  "@yaronyanir1299",
  "@ynetalerts",
  "@idf_telegram",
];

// Private channels (invite hash + channel ID for URL building)
interface PrivateChannel {
  inviteHash: string; // from t.me/joinchat/...
  channelId: string; // from t.me/c/1023468930/... (without -100 prefix)
  title: string; // for logs/identification
}

const PRIVATE_CHANNELS: PrivateChannel[] = [
  {
    inviteHash: "AmLhsj0A5YJbpv0XtJQENg",
    channelId: "1023468930",
    title: "Private Intel Group",
  },
];

// ── Helpers ────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(baseMs: number): number {
  return baseMs + Math.random() * 500 - 250;
}

// ── Client ─────────────────────────────────────────────

export async function startMonitor(): Promise<void> {
  if (!config.agent.enabled) return;

  const { apiId, apiHash, sessionString } = config.agent.mtproto;

  if (!apiId || !apiHash) {
    logger.warn(
      "GramJS: api_id or api_hash not set — MTProto monitor disabled",
    );
    return;
  }

  const session = new StringSession(sessionString || "");

  const clientOpts: AnyOpts = {
    connectionRetries: 5,
    retryDelay: 2000,
    autoReconnect: true,
    deviceModel: "Desktop",
    appVersion: "1.0.0",
    systemVersion: "macOS 14",
    langCode: "en",
  };

  // SOCKS5 proxy support
  if (config.agent.socks5Proxy) {
    try {
      const proxyUrl = new URL(config.agent.socks5Proxy);
      clientOpts.proxy = {
        socksType: 5,
        ip: proxyUrl.hostname,
        port: Number(proxyUrl.port),
        username: proxyUrl.username || undefined,
        password: proxyUrl.password || undefined,
      };
      logger.info("GramJS: SOCKS5 proxy configured", {
        host: proxyUrl.hostname,
      });
    } catch {
      logger.warn("GramJS: invalid socks5_proxy URL, ignoring");
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _client = new TelegramClient(session, apiId, apiHash, clientOpts as any);

  if (!sessionString) {
    logger.warn(
      "GramJS: no session_string configured. Run `npx tsx src/agent/auth.ts` first.",
    );
    return;
  }

  try {
    await _client.connect();
    logger.info("GramJS: connected to Telegram MTProto");
  } catch (err) {
    logger.error("GramJS: connection failed", { error: String(err) });
    return;
  }

  // Get all dialogs to check existing memberships
  let existingChannels: Set<string> = new Set();
  let existingPrivateIds: Set<string> = new Set();

  try {
    const dialogs = await _client.getDialogs({ limit: 200 });
    for (const dialog of dialogs) {
      const entity = dialog.entity;
      // Public channel username
      if (entity && "username" in entity && entity.username) {
        existingChannels.add(String(entity.username).toLowerCase());
      }
      // Private channel ID
      if (entity && "id" in entity) {
        existingPrivateIds.add(String(entity.id));
      }
    }
    logger.info("GramJS: fetched existing dialogs", {
      total: dialogs.length,
    });
  } catch (err) {
    logger.warn("GramJS: failed to fetch dialogs, will try joining anyway", {
      error: String(err),
    });
  }

  // Auto-join all monitored public channels (required for NewMessage events)
  for (const ch of MONITORED_CHANNELS) {
    const username = ch.replace("@", "");
    const normalizedUsername = username.toLowerCase();

    // Check if already a member
    if (existingChannels.has(normalizedUsername)) {
      logger.debug("GramJS: already in channel", { channel: ch });
      continue;
    }

    try {
      await _client.invoke(new Api.channels.JoinChannel({ channel: username }));
      logger.info("GramJS: joined channel", { channel: ch });
    } catch (err: unknown) {
      const errStr = String(err);
      if (errStr.includes("USER_ALREADY_PARTICIPANT")) {
        logger.debug("GramJS: already in channel (via API)", { channel: ch });
      } else {
        logger.warn("GramJS: failed to join channel", {
          channel: ch,
          error: errStr,
        });
      }
    }
    // Rate limit: 1-2s between joins
    await sleep(jitter(1500));
  }

  // Auto-join private channels via invite hash
  for (const priv of PRIVATE_CHANNELS) {
    // Check if already a member by channel ID
    if (existingPrivateIds.has(priv.channelId)) {
      logger.debug("GramJS: already in private channel", { title: priv.title });
      continue;
    }

    try {
      await _client.invoke(
        new Api.messages.ImportChatInvite({ hash: priv.inviteHash }),
      );
      logger.info("GramJS: joined private channel", { title: priv.title });
    } catch (err: unknown) {
      const errStr = String(err);
      if (
        errStr.includes("USER_ALREADY_PARTICIPANT") ||
        errStr.includes("INVITE_HASH_EXPIRED")
      ) {
        logger.debug("GramJS: already in private channel or hash expired", {
          title: priv.title,
        });
      } else {
        logger.warn("GramJS: failed to join private channel", {
          title: priv.title,
          error: errStr,
        });
      }
    }
    // Rate limit: 1-2s between joins
    await sleep(jitter(1500));
  }

  // Subscribe to new messages across all monitored channels
  _client.addEventHandler(async (event: NewMessageEvent) => {
    await handleNewMessage(event).catch((err) => {
      logger.warn("GramJS: handler error", { error: String(err) });
    });
  }, new NewMessage({}));

  logger.info("GramJS: monitoring channels", {
    public: MONITORED_CHANNELS.length,
    private: PRIVATE_CHANNELS.length,
  });
}

async function handleNewMessage(event: NewMessageEvent): Promise<void> {
  const msg = event.message;
  if (!msg?.text || !msg.peerId) {
    logger.debug("GramJS: skipped message (no text or peerId)");
    return;
  }

  // Get channel identifier (username or title)
  let channel = "";
  let channelId = ""; // for private channels
  let isPrivate = false;

  try {
    const chat = await event.message.getChat();

    // Try to extract channel ID from peerId (for private channels)
    if (msg.peerId && "channelId" in msg.peerId) {
      // channelId is stored as bigint, convert to string
      const rawId = String(msg.peerId.channelId);
      channelId = rawId;
    }

    // Check if it's a monitored private channel
    const privateMatch = PRIVATE_CHANNELS.find(
      (p) => p.channelId === channelId,
    );
    if (privateMatch) {
      channel = privateMatch.title;
      isPrivate = true;
    } else if (chat && "username" in chat && chat.username) {
      channel = `@${chat.username}`;
    } else if (chat && "title" in chat && chat.title) {
      channel = String(chat.title);
    } else {
      logger.debug("GramJS: skipped message (unidentifiable chat)");
      return; // Not a channel we can identify
    }
  } catch {
    return;
  }

  // Only care about configured channels (public or private)
  const normalizedChannel = channel.toLowerCase();
  const isMonitored =
    isPrivate ||
    MONITORED_CHANNELS.some(
      (c) =>
        c.toLowerCase() === normalizedChannel ||
        c.toLowerCase().replace("@", "") === normalizedChannel.replace("@", ""),
    );

  if (!isMonitored) {
    logger.debug("GramJS: skipped message (not monitored)", { channel });
    return;
  }

  // Only store if there's an active alert window
  const active = await getActiveAlert();
  if (!active) {
    logger.debug("GramJS: skipped message (no active alert)", { channel });
    return;
  }

  // Anti-flood: jittered delay
  await sleep(jitter(1000));

  // Build direct message URL
  let messageUrl: string;
  if (isPrivate) {
    // Private channel: https://t.me/c/1023468930/123
    messageUrl = `https://t.me/c/${channelId}/${msg.id}`;
  } else {
    // Public channel: https://t.me/username/123
    const username = channel.replace("@", "");
    messageUrl = `https://t.me/${username}/${msg.id}`;
  }

  await pushChannelPost(active.alertId, {
    channel,
    text: msg.text,
    ts: Date.now(),
    messageUrl,
  });

  logger.info("GramJS: stored channel post", {
    channel,
    alertId: active.alertId,
    text_len: msg.text.length,
    private: isPrivate,
  });
}

export async function stopMonitor(): Promise<void> {
  if (_client) {
    await _client.disconnect();
    _client = null;
    logger.info("GramJS: disconnected");
  }
}

// ── Fetch recent posts (used by MCP tools) ─────────────

/**
 * Fetch recent messages from a public Telegram channel via MTProto.
 * Used by the telegram_mtproto_mcp_read_sources MCP tool.
 *
 * @param channel - Channel username with @ prefix (e.g. "@idf_telegram")
 * @param limit - Number of messages to fetch (1-20)
 * @returns Array of ChannelPost objects (newest first)
 */
export async function fetchRecentChannelPosts(
  channel: string,
  limit: number = 5,
): Promise<Array<{ text: string; ts: number; messageUrl?: string }>> {
  if (!_client?.connected) {
    logger.warn("GramJS: fetchRecentChannelPosts — client not connected");
    return [];
  }

  const username = channel.replace("@", "");
  const safeLimit = Math.min(Math.max(limit, 1), 20);

  try {
    // Rate limit: jittered delay before fetching
    await sleep(jitter(1000));

    const messages = await _client.getMessages(username, {
      limit: safeLimit,
    });

    return messages
      .filter((msg) => msg.text)
      .map((msg) => ({
        text: msg.text ?? "",
        ts: msg.date ? msg.date * 1000 : Date.now(),
        messageUrl: `https://t.me/${username}/${msg.id}`,
      }));
  } catch (err) {
    logger.warn("GramJS: fetchRecentChannelPosts failed", {
      channel,
      error: String(err),
    });
    return [];
  }
}
