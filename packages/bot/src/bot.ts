/**
 * EasyOref — Real-time Israeli Red Alert Filter Bot
 *
 * Architecture:
 *   oref.org.il API → local filter (area map) → Telegram (grammY)
 *
 * Flow:
 *   1. Poll oref.org.il every 2 seconds for active alerts
 *   2. Match areas against configured regions (Hebrew names)
 *   3. Classify alert type: early warning / red_alert / incident over
 *   4. If relevant → send calm message to configured Telegram chat
 *
 * No LLM needed — purely deterministic matching for <1s latency.
 */

import {
  enqueueEnrich,
  runCanary,
  startEnrichWorker,
  stopEnrichWorker,
} from "@easyoref/agent";
import { isGramJsConnected, startMonitor, stopMonitor } from "@easyoref/gramjs";
import {
  AlertType,
  clearSession,
  closeRedis,
  config,
  fetchActiveAlerts,
  getActiveSession,
  getAlertEmoji,
  getAllUsers,
  getLanguagePack,
  getLastUpdateTs,
  initLangSmithTracing,
  initTranslations,
  loadCooldownState,
  PHASE_INITIAL_DELAY_MS,
  RESOLVED_RUN_OFFSETS_MS,
  saveAlertMeta,
  saveCooldownState,
  setActiveSession,
  textHash,
  translateAreas,
  type ActiveSessionType as ActiveSession,
  type Language,
  type PikudAlert,
  type TelegramMessageType as TelegramMessage,
  type UserConfigType as UserConfig,
} from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import { Bot } from "grammy";
import { createServer } from "node:http";
import { initGifState, pickGif } from "./gif-state.js";
import { registerAdminHandler } from "./handlers/admin.js";
import { registerInlineHandler } from "./handlers/inline.js";
import { registerQaHandler } from "./handlers/qa.js";
import { registerSettingsHandler } from "./handlers/settings.js";
import { registerShelterHandler } from "./handlers/shelter.js";
import { initDefaultAreas, registerStartHandler } from "./handlers/start.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Per-user Area Filter
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Check if this user has any of their configured areas in the alert. */
function userMatchesAlert(user: UserConfig, alertAreas: string[]): boolean {
  if (user.areas.length === 0) return true; // no filter → all alerts
  return user.areas.some((monitored) =>
    alertAreas.some(
      (a) =>
        a === monitored || a.startsWith(monitored) || monitored.startsWith(a),
    ),
  );
}

/** Return the user's matched area label, falling back to full alert areas. */
function userMatchedLabel(user: UserConfig, alertAreas: string[]): string {
  if (user.areas.length === 0) return alertAreas.slice(0, 3).join(", ");
  const matched = alertAreas.filter((a) =>
    user.areas.some((m) => a === m || a.startsWith(m) || m.startsWith(a)),
  );
  return matched.length > 0
    ? matched.join(", ")
    : alertAreas.slice(0, 3).join(", ");
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Alert Type Classification
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Map internal AlertType → YAML config key */
const ALERT_TYPE_TO_CONFIG: Record<
  AlertType,
  "early" | "red_alert" | "resolved"
> = {
  early_warning: "early",
  red_alert: "red_alert",
  resolved: "resolved",
};

function classifyAlertType(title: string): AlertType {
  if (title.includes("האירוע הסתיים")) return "resolved";
  if (title.includes("בדקות הקרובות") || title.includes("צפויות להתקבל"))
    return "early_warning";
  return "red_alert";
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Health tracking
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let lastAlertTs = 0;
let registeredUserCount = 0;

/** Called by processAlert after sending a Telegram message */
function trackAlert(): void {
  lastAlertTs = Date.now();
}

/** Update registered user count (called periodically) */
async function refreshUserCount(): Promise<void> {
  try {
    const users = await getAllUsers();
    registeredUserCount = users.length;
  } catch {
    // non-critical
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Cooldown / Dedup
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const COOLDOWN_EARLY_MS = 3 * 60 * 1000; // 3 min (Oref sends multiple alert IDs per wave)
const COOLDOWN_RED_ALERT_MS = 3 * 60 * 1000; // 3 min (same as after-early; Oref sends same wave via Alerts.json + AlertsHistory with different IDs)
const COOLDOWN_RED_ALERT_AFTER_EARLY_MS = 3 * 60 * 1000; // 3 min (early warning already sent)
const COOLDOWN_RESOLVED_MS = 5 * 60 * 1000; // 5 min

let lastSent: Record<AlertType, number> = {
  early_warning: 0,
  red_alert: 0,
  resolved: 0,
};

/** Load cooldown state from Redis on startup (survives restart). */
async function initCooldownState(): Promise<void> {
  try {
    lastSent = await loadCooldownState();
    const nonZero = Object.entries(lastSent).filter(([, v]) => v > 0);
    if (nonZero.length > 0) {
      logger.info("Cooldown state restored from Redis", {
        entries: nonZero.map(([k, v]) => `${k}=${Date.now() - v}ms ago`),
      });
    }
  } catch {
    // Non-critical — start with zeros if Redis fails
  }
}

function shouldSend(type: AlertType): boolean {
  const elapsed = Date.now() - lastSent[type];
  switch (type) {
    case "early_warning":
      return elapsed >= COOLDOWN_EARLY_MS;
    case "resolved":
      return elapsed >= COOLDOWN_RESOLVED_MS;
    case "red_alert": {
      const cd =
        lastSent.early_warning > 0
          ? COOLDOWN_RED_ALERT_AFTER_EARLY_MS
          : COOLDOWN_RED_ALERT_MS;
      return elapsed >= cd;
    }
  }
}

function markSent(type: AlertType): void {
  const now = Date.now();
  lastSent[type] = now;
  // After resolved → reset ALL others (new attack cycle)
  if (type === "resolved") {
    lastSent.early_warning = 0;
    lastSent.red_alert = 0;
  }
  // After red_alert → allow resolved (same wave continues; early_warning cooldown preserved)
  if (type === "red_alert") {
    lastSent.resolved = 0;
  }
  // After early_warning → allow resolved
  if (type === "early_warning") lastSent.resolved = 0;

  // Persist to Redis (fire-and-forget, non-blocking)
  saveCooldownState(lastSent).catch(() => {});
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Oref Poller
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const seenAlerts = new Set<string>();

/** Deterministic ID for dedup when pikud-haoref-api returns no id (history fallback). */
function alertDedupKey(alert: PikudAlert): string {
  return alert.id ?? textHash([alert.type, ...alert.cities.sort()].join("|"));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GIF Pools by Mode
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── funny_cats ────────────────────────────────────────

const CATS_EARLY_WARNING = [
  "https://media.giphy.com/media/wQI5H4jtqZEPK/giphy.gif",
  "https://media.giphy.com/media/pD83kYQkhuhgY/giphy.gif",
  "https://media.giphy.com/media/W2FXGIVejFptc6CSxY/giphy.gif",
  "https://media1.tenor.com/m/iM6XLBMUKNcAAAAd/cat-kitty.mp4",
  "https://media1.tenor.com/m/fZ-SvpmkgSUAAAAd/uni-unico.mp4",
  "https://media1.tenor.com/m/1KwzId7qyyQAAAAd/bye-goodbye.gif",
  "https://media1.tenor.com/m/jXHAct5B8uwAAAAd/cat-hiding-in-the-box-cat.gif",
  "https://media1.tenor.com/m/GjeodmMXY2AAAAAd/cat-shy.gif",
  "https://media1.tenor.com/m/yz_7VcX0WjYAAAAd/cat-changing-the-clock-changing-the-time.gif",
];

const CATS_EARLY_WARNING_NIGHT = [
  "https://media.giphy.com/media/5UH2PJ8VIEuMqN8V6R/giphy.gif",
  "https://media.tenor.com/4gH8RagrsjAAAAPo/wake-up-viralhog.mp4",
  "https://media1.tenor.com/m/4NJKe0rdz9AAAAAd/cat-kitty.mp4",
  "https://media1.tenor.com/m/nsbw7SM-rYMAAAAd/wake-up-cat-tapping.gif",
  "https://media1.tenor.com/m/S5N8d-OpyNEAAAAC/extasyxx.gif",
  "https://media1.tenor.com/m/-1dJGIwOFo8AAAAC/wake-up-hooman-husky.gif",
];

const CATS_RED_ALERT = [
  "https://media1.tenor.com/m/9vcHsGLyJmgAAAAd/cat-alarm-alarm.mp4",
  "https://media.tenor.com/Wx3bGh80AWkAAAPo/siren-cat.mp4",
  "https://media.giphy.com/media/WLGJGG9JjpUrmUWkYf/giphy.gif",
  "https://media1.tenor.com/m/0XHXUdzJ9KIAAAAd/cat-meme.mp4",
  "https://media1.tenor.com/m/J3sih0hnKLwAAAAC/borzoi-siren.mp4",
  "https://media1.tenor.com/m/JhrBK6zYao0AAAAC/cat-orange.gif",
];

const CATS_RESOLVED = [
  "https://media.tenor.com/eRGgvoRJNqAAAAPo/cat-silly.mp4",
  "https://media.tenor.com/aePEdx5RyFcAAAPo/cat-petsure.mp4",
  "https://media.tenor.com/wP_lARteJosAAAPo/cat-box.mp4",
  "https://media1.tenor.com/m/Td6hJ6AayEgAAAAd/cats-leave.mp4",
  "https://media1.tenor.com/m/eaLwOMoptpcAAAAd/rexi-im-out.mp4",
  "https://media1.tenor.com/m/MkyiUsAp8t8AAAAd/tom-and-jerry-tom-the-cat.gif",
  "https://media1.tenor.com/m/imeu4GvhB2sAAAAC/cat-kitten.gif",
  "https://media1.tenor.com/m/swIMdJZK8F0AAAAd/kitten-relaxing-paws.gif",
];

// ── Pool map by mode ──────────────────────────────────

type GifPools = {
  early: string[];
  earlyNight: string[];
  red_alert: string[];
  resolved: string[];
};

const GIF_POOLS: Record<string, GifPools> = {
  funny_cats: {
    early: CATS_EARLY_WARNING,
    earlyNight: [...CATS_EARLY_WARNING, ...CATS_EARLY_WARNING_NIGHT],
    red_alert: CATS_RED_ALERT,
    resolved: CATS_RESOLVED,
  },
};

/** Is it nighttime in Israel? (03:00–10:59) */
function isNightInIsrael(): boolean {
  const h = Number(
    new Date().toLocaleTimeString("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: "Asia/Jerusalem",
    }),
  );
  return h >= 3 && h < 11;
}

function getGifUrl(alertType: AlertType): string | null {
  const mode = config.gifMode;

  if (mode === "none") return null;

  const pools = GIF_POOLS[mode];
  if (!pools) return null;

  switch (alertType) {
    case "early_warning": {
      const pool = isNightInIsrael() ? pools.earlyNight : pools.early;
      return pickGif(
        pool,
        isNightInIsrael() ? `${mode}_early_night` : `${mode}_early`,
      );
    }
    case "red_alert":
      return pickGif(pools.red_alert, `${mode}_red_alert`);
    case "resolved":
      return pickGif(pools.resolved, `${mode}_resolved`);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Telegram
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let bot: Bot | null = null;

function initBot(): Bot | null {
  if (!config.botToken) {
    logger.error("BOT_TOKEN not set — Telegram DISABLED");
    return null;
  }
  logger.info("Bot initialized", { gif_mode: config.gifMode });
  return new Bot(config.botToken);
}

function nowHHMM(): string {
  return new Date().toLocaleTimeString("he-IL", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jerusalem",
  });
}

function formatMessage(
  alertType: AlertType,
  areas: string,
  language?: Language,
): string {
  const time = nowHHMM();
  const lang = language ?? "ru";
  const localAreas = translateAreas(areas, lang);
  const cfgKey = ALERT_TYPE_TO_CONFIG[alertType];

  const lp = getLanguagePack(lang);
  const defaults = lp.alerts[cfgKey];
  const labels = lp.labels;

  const emoji = config.emojiOverride[cfgKey] ?? getAlertEmoji(cfgKey);
  const title = config.titleOverride[cfgKey] ?? defaults.title;
  const desc = config.descriptionOverride[cfgKey] ?? defaults.description;

  const lines: string[] = [`<b>${emoji} ${title}</b> (${time})`];
  if (desc) lines.push(desc);

  // District line — blank line before, always plain text
  lines.push("", `\u{1F4CD} ${labels.area}: ${localAreas}`);

  return lines.join("\n");
}

/** Send message and return {messageId, isCaption} for agent editing */
async function sendTelegram(
  chatId: string,
  alertType: AlertType,
  text: string,
  replyToMessageId?: number,
): Promise<{ messageId: number; isCaption: boolean } | null> {
  if (!bot || !chatId) {
    logger.error("Telegram unavailable", {
      bot_exists: !!bot,
      chat_id: chatId,
    });
    return null;
  }

  const gifUrl = getGifUrl(alertType);
  const replyOpts = replyToMessageId
    ? {
        reply_to_message_id: replyToMessageId,
        allow_sending_without_reply: true,
      }
    : {};

  // No GIF mode → send text only
  if (!gifUrl) {
    try {
      const msg = await bot.api.sendMessage(chatId, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...replyOpts,
      });
      logger.info("Alert sent via Telegram (text)", {
        type: alertType,
        chatId,
        reply_to: replyToMessageId,
      });
      return { messageId: msg.message_id, isCaption: false };
    } catch (err) {
      logger.error("Telegram send failed", {
        error: String(err),
        type: alertType,
        chatId,
      });
      return null;
    }
  }

  // GIF mode → try animation, fall back to text
  try {
    const msg = await bot.api.sendAnimation(chatId, gifUrl, {
      caption: text,
      parse_mode: "HTML",
      ...replyOpts,
    });
    logger.info("Alert sent via Telegram (GIF)", {
      type: alertType,
      gif_url: gifUrl,
      chatId,
      reply_to: replyToMessageId,
    });
    return { messageId: msg.message_id, isCaption: true };
  } catch (err) {
    logger.warn("GIF send failed, falling back to text", {
      error: String(err),
      gif_url: gifUrl,
      chatId,
    });
    try {
      const msg = await bot.api.sendMessage(chatId, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...replyOpts,
      });
      logger.info("Alert sent via Telegram (text fallback)", {
        type: alertType,
        chatId,
        reply_to: replyToMessageId,
      });
      return { messageId: msg.message_id, isCaption: false };
    } catch (err2) {
      logger.error("Telegram send failed completely", {
        error: String(err2),
        type: alertType,
        chatId,
      });
      return null;
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Alert Processing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function processAlert(alert: PikudAlert): Promise<void> {
  const dedupKey = alertDedupKey(alert);
  // ── Load all registered users and find those matching this alert's areas ──
  const allUsers = await getAllUsers();
  const matchedUsers = allUsers.filter((u) =>
    userMatchesAlert(u, alert.cities),
  );

  if (matchedUsers.length === 0) {
    logger.info("Alert — no users matched area", {
      alert_id: dedupKey,
      areas_he: alert.cities,
    });
    return;
  }

  const alertType = classifyAlertType(alert.instructions ?? "");

  // Filter by configured alert types
  const cfgKey = ALERT_TYPE_TO_CONFIG[alertType];
  if (!config.alertTypes.includes(cfgKey)) {
    logger.info("Alert type filtered out by config", {
      alert_id: dedupKey,
      type: alertType,
      config_key: cfgKey,
    });
    return;
  }

  const areas = matchedUsers[0]
    ? userMatchedLabel(matchedUsers[0], alert.cities)
    : alert.cities.slice(0, 3).join(", ");

  logger.info("Alert — RELEVANT", {
    alert_id: dedupKey,
    type: alertType,
    areas_he: alert.cities,
    matched_users: matchedUsers.length,
  });

  if (!shouldSend(alertType)) {
    logger.info("Cooldown active, skipping Telegram", {
      alert_id: dedupKey,
      type: alertType,
    });
    return;
  }

  markSent(alertType);
  trackAlert();

  // Build canonical (English) base message for session storage
  const baseMessage = formatMessage(alertType, areas, "en");
  const alertTs = Date.now();

  // ── Reply chain (per-session) ──
  const replyToMap = new Map<string, number>();
  if (config.agent.enabled) {
    const existingForReply = await getActiveSession();
    const shouldReply =
      existingForReply &&
      (alertType === "resolved" || existingForReply.phase !== "resolved");
    if (shouldReply) {
      const cms: TelegramMessage[] = existingForReply.telegramMessages ?? [
        {
          chatId: existingForReply.chatId,
          messageId: existingForReply.latestMessageId,
          isCaption: existingForReply.isCaption,
        },
      ];
      for (const cm of cms) {
        replyToMap.set(cm.chatId, cm.messageId);
      }
    }
  }

  try {
    // ── Send to each matched user in their language ──
    const telegramMessages: TelegramMessage[] = [];
    for (const user of matchedUsers) {
      const isPro = user.tier === "pro";

      const lang = (user.language ?? "ru") as Language;
      const userAreaLabel = userMatchedLabel(user, alert.cities);
      const message = formatMessage(alertType, userAreaLabel, lang);

      const replyTo = replyToMap.get(user.chatId);
      const sent = await sendTelegram(user.chatId, alertType, message, replyTo);
      if (sent) {
        telegramMessages.push({
          chatId: user.chatId,
          messageId: sent.messageId,
          isCaption: sent.isCaption,
          language: user.language,
          baseText: formatMessage(alertType, userAreaLabel, lang),
          tier: isPro ? "pro" : "free",
        });
      }
    }

    const proMessages = telegramMessages.filter((t) => t.tier === "pro");
    if (proMessages.length === 0 && telegramMessages.length === 0) return;
    const primary = proMessages[0] ?? telegramMessages[0]!;

    // ── Session-based enrichment lifecycle ──
    if (config.agent.enabled) {
      const existingSession = await getActiveSession();

      // Save meta for this alert (primary chat; English canonical text)
      await saveAlertMeta({
        alertId: dedupKey,
        messageId: primary.messageId,
        chatId: primary.chatId,
        isCaption: primary.isCaption,
        alertTs,
        alertType,
        alertAreas: alert.cities,
        currentText: baseMessage,
      });

      if (alertType === "resolved") {
        // ── Resolved: switch existing session to resolved phase ──
        if (existingSession) {
          const updated: ActiveSession = {
            ...existingSession,
            phase: "resolved",
            phaseStartTs: Date.now(),
            latestAlertId: dedupKey,
            latestMessageId: primary.messageId,
            latestAlertTs: alertTs,
            chatId: primary.chatId,
            isCaption: primary.isCaption,
            currentText: baseMessage,
            baseText: baseMessage,
            telegramMessages,
          };
          await setActiveSession(updated);
          const delay = RESOLVED_RUN_OFFSETS_MS[0];
          await enqueueEnrich(dedupKey, alertTs, delay);
          logger.info("Session: entered resolved phase", {
            sessionId: existingSession.sessionId,
            alertId: dedupKey,
          });
        } else {
          logger.info("Resolved alert without active session — no enrichment", {
            alert_id: dedupKey,
          });
        }
      } else {
        // ── Early warning / Red Alert ──
        if (existingSession && existingSession.phase !== "resolved") {
          // Upgrade session phase (early → red_alert, or same-type refresh)
          const updated: ActiveSession = {
            ...existingSession,
            phase: alertType,
            phaseStartTs: Date.now(),
            latestAlertId: dedupKey,
            latestMessageId: primary.messageId,
            latestAlertTs: alertTs,
            chatId: primary.chatId,
            isCaption: primary.isCaption,
            currentText: baseMessage,
            baseText: baseMessage,
            alertAreas: alert.cities,
            telegramMessages,
          };
          await setActiveSession(updated);
          logger.info("Session: upgraded phase", {
            sessionId: existingSession.sessionId,
            from: existingSession.phase,
            to: alertType,
            alertId: dedupKey,
          });
        } else {
          // New session (or previous one was in resolved — start fresh)
          if (existingSession) {
            await clearSession();
          }
          const session: ActiveSession = {
            sessionId: dedupKey,
            sessionStartTs: alertTs,
            phase: alertType,
            phaseStartTs: alertTs,
            latestAlertId: dedupKey,
            latestMessageId: primary.messageId,
            latestAlertTs: alertTs,
            chatId: primary.chatId,
            isCaption: primary.isCaption,
            currentText: baseMessage,
            baseText: baseMessage,
            alertAreas: alert.cities,
            telegramMessages,
          };
          await setActiveSession(session);
          logger.info("Session: started", {
            sessionId: dedupKey,
            phase: alertType,
            chatCount: telegramMessages.length,
          });
        }

        const delay = PHASE_INITIAL_DELAY_MS[alertType];
        await enqueueEnrich(dedupKey, alertTs, delay);
      }
    }
  } catch (err) {
    logger.error("Alert send/store failed", {
      error: String(err),
      alert_id: dedupKey,
    });
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Health Server
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function startHealthServer(): void {
  const server = createServer(async (req, res) => {
    if (req.url === "/health") {
      let redisConnected = false;
      let activeSessionPhase: string | null = null;
      let lastEnrichTs = 0;
      try {
        const session = await getActiveSession();
        activeSessionPhase = session?.phase ?? null;
        lastEnrichTs = await getLastUpdateTs();
        redisConnected = true;
      } catch {
        // Redis unreachable
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          service: "easyoref",
          uptime: process.uptime(),
          seen_alerts: seenAlerts.size,
          gif_mode: config.gifMode,
          last_alert_ts: lastAlertTs || null,
          last_enrichment_ts: lastEnrichTs || null,
          registered_users: registeredUserCount,
          redis_connected: redisConnected,
          gramjs_connected: config.agent.enabled ? isGramJsConnected() : null,
          active_session_phase: activeSessionPhase,
          agent_enabled: config.agent.enabled,
        }),
      );
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  server.listen(config.healthPort, () => {
    logger.info("Health server started", { port: config.healthPort });
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Main
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function main(): Promise<void> {
  logger.info("EasyOref starting", {
    poll_interval_ms: config.pollIntervalMs,
    telegram: config.botToken ? "enabled" : "disabled",
    gif_mode: config.gifMode,
  });

  // Load area translations (fetches cities.json from pikud-haoref-api).
  // Retry once if network not ready yet (common on RPi cold boot).
  await initTranslations().catch(async () => {
    logger.warn("initTranslations failed — retrying in 30s");
    await new Promise((r) => setTimeout(r, 30_000));
    await initTranslations().catch(() => {
      logger.warn(
        "initTranslations failed on retry — area names may show in Hebrew",
      );
    });
  });

  initGifState(config.dataDir);
  await initCooldownState();
  bot = initBot();
  if (bot) {
    initDefaultAreas();
    registerStartHandler(bot);
    registerSettingsHandler(bot);
    registerAdminHandler(bot);
    registerShelterHandler(bot);
    registerQaHandler(bot);
    registerInlineHandler(bot);

    // Set bot menu commands (per-language)
    const commands = [
      { command: "start", description: "Register / restart" },
      { command: "settings", description: "Settings" },
    ];
    bot.api.setMyCommands(commands).catch((err: unknown) => {
      logger.warn("Failed to set bot commands", { error: String(err) });
    });

    bot.start({ drop_pending_updates: true }).catch((err: unknown) => {
      logger.error("Bot polling failed", { error: String(err) });
    });
  }
  startHealthServer();

  // Start agent subsystems if enabled
  if (config.agent.enabled) {
    initLangSmithTracing();
    startEnrichWorker();
    await startMonitor();
    logger.info("Agent subsystems started", {
      filterModel: config.agent.filterModel,
      provider: "openrouter.ai",
      channels: 14, // MONITORED_CHANNELS length (hardcoded)
      enrich_delay_ms: config.agent.enrichDelayMs,
    });

    // Canary: synthetic self-test (non-blocking)
    if (config.agent.canary) {
      runCanary().catch((err) => {
        logger.error("Canary failed", { error: String(err) });
      });
    }
  }

  // Poll loop
  setInterval(async () => {
    try {
      const alerts = await fetchActiveAlerts();
      for (const alert of alerts) {
        const key = alertDedupKey(alert);
        if (seenAlerts.has(key)) continue;
        seenAlerts.add(key);
        await processAlert(alert);
      }
    } catch (err) {
      logger.error("Poll error", { error: String(err) });
    }
  }, config.pollIntervalMs);

  // Heartbeat — flush Logtail buffer + refresh user count every 30s
  setInterval(async () => {
    logger.debug("heartbeat", {
      uptime_s: Math.round(process.uptime()),
      seen_alerts: seenAlerts.size,
    });
    await refreshUserCount();
    await logger.flush();
  }, 30_000);

  // Graceful shutdown
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      logger.info(`Shutting down (${sig})`);
      await stopMonitor();
      await stopEnrichWorker();
      await closeRedis();
      await logger.flush();
      process.exit(0);
    });
  }
}

main().catch(async (err) => {
  logger.error("Fatal error", { error: String(err) });
  await logger.flush();
  process.exit(1);
});
