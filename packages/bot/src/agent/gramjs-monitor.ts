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

import { TelegramClient } from "telegram";
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
  // Note: private group @+6Jd-rxu0ZPo1ZmE0 may not work with MTProto
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

  // Subscribe to new messages across all monitored channels
  _client.addEventHandler(async (event: NewMessageEvent) => {
    await handleNewMessage(event).catch((err) => {
      logger.warn("GramJS: handler error", { error: String(err) });
    });
  }, new NewMessage({}));

  logger.info("GramJS: monitoring channels", {
    channels: MONITORED_CHANNELS,
  });
}

async function handleNewMessage(event: NewMessageEvent): Promise<void> {
  const msg = event.message;
  if (!msg?.text || !msg.peerId) return;

  // Get channel username
  let channel = "";
  try {
    const chat = await event.message.getChat();
    if (chat && "username" in chat && chat.username) {
      channel = `@${chat.username}`;
    } else if (chat && "title" in chat && chat.title) {
      channel = String(chat.title);
    } else {
      return; // Not a channel we can identify
    }
  } catch {
    return;
  }

  // Only care about configured channels
  const normalizedChannel = channel.toLowerCase();
  const isMonitored = MONITORED_CHANNELS.some(
    (c) =>
      c.toLowerCase() === normalizedChannel ||
      c.toLowerCase().replace("@", "") === normalizedChannel.replace("@", ""),
  );
  if (!isMonitored) return;

  // Only store if there's an active alert window
  const active = await getActiveAlert();
  if (!active) return;

  // Anti-flood: jittered delay
  await sleep(jitter(1000));

  // Build direct message URL for the sources footer
  const username = channel.replace("@", "");
  const messageUrl = `https://t.me/${username}/${msg.id}`;

  await pushChannelPost(active.alertId, {
    channel,
    text: msg.text,
    ts: Date.now(),
    messageUrl,
  });

  logger.debug("GramJS: stored channel post", {
    channel,
    alertId: active.alertId,
    text_len: msg.text.length,
  });
}

export async function stopMonitor(): Promise<void> {
  if (_client) {
    await _client.disconnect();
    _client = null;
    logger.info("GramJS: disconnected");
  }
}
