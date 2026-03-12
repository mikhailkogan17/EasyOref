/**
 * EasyOref — Real-time Israeli Red Alert Filter Bot
 *
 * Architecture:
 *   oref.org.il API → local filter (area map) → Telegram (grammY)
 *
 * Flow:
 *   1. Poll oref.org.il every 2 seconds for active alerts
 *   2. Match areas against configured regions (Hebrew names)
 *   3. Classify alert type: early warning / siren / incident over
 *   4. If relevant → send calm message to family Telegram chat
 *
 * No LLM needed — purely deterministic matching for <1s latency.
 */

import { Bot } from "grammy";
import { createServer } from "node:http";
import { startMonitor, stopMonitor } from "./agent/gramjs-monitor.js";
import { enqueueEnrich } from "./agent/queue.js";
import { closeRedis } from "./agent/redis.js";
import { buildEnrichedMessage, MONITORING_RE, stripMonitoring } from "./agent/message.js";
import {
  clearSession,
  getActiveSession,
  getEnrichmentData,
  PHASE_ENRICH_DELAY_MS,
  PHASE_INITIAL_DELAY_MS,
  saveAlertMeta,
  setActiveSession,
  type ActiveSession,
} from "./agent/store.js";
import { startEnrichWorker, stopEnrichWorker } from "./agent/worker.js";
import { config, type AlertTypeConfig } from "./config.js";
import { initGifState, pickGif } from "./gif-state.js";
import {
  getLanguagePack,
  initTranslations,
  resolveCityIds,
  translateAreas,
} from "./i18n.js";
import * as logger from "./logger.js";

const langPack = getLanguagePack(config.language);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Area Filter (configurable via AREAS env var)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Check if alert data contains any of our monitored areas. */
function isRelevantArea(alertAreas: string[]): boolean {
  for (const monitored of config.areas) {
    if (alertAreas.includes(monitored)) return true;
    if (
      alertAreas.some((a) => a.startsWith(monitored) || monitored.startsWith(a))
    )
      return true;
  }
  return false;
}

/** Return human-readable area label for messages */
function matchedAreaLabel(alertAreas: string[]): string {
  const matched = alertAreas.filter((a) =>
    config.areas.some((m) => a.startsWith(m) || m.startsWith(a) || a === m),
  );
  return matched.length > 0
    ? matched.join(", ")
    : alertAreas.slice(0, 3).join(", ");
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Alert Type Classification
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

type AlertType = "early_warning" | "siren" | "resolved";

/** Map internal AlertType → YAML config key */
const ALERT_TYPE_TO_CONFIG: Record<AlertType, AlertTypeConfig> = {
  early_warning: "early",
  siren: "siren",
  resolved: "resolved",
};

function classifyAlertType(title: string): AlertType {
  if (title.includes("האירוע הסתיים")) return "resolved";
  if (title.includes("בדקות הקרובות") || title.includes("צפויות להתקבל"))
    return "early_warning";
  return "siren";
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Cooldown / Dedup
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const COOLDOWN_EARLY_MS = 2 * 60 * 1000; // 2 min (Oref sends multiple IDs per wave)
const COOLDOWN_SIREN_MS = 90 * 1000; // 1.5 min (no prior early warning)
const COOLDOWN_SIREN_AFTER_EARLY_MS = 3 * 60 * 1000; // 3 min (early warning already sent)
const COOLDOWN_RESOLVED_MS = 5 * 60 * 1000; // 5 min

const lastSent: Record<AlertType, number> = {
  early_warning: 0,
  siren: 0,
  resolved: 0,
};

function shouldSend(type: AlertType): boolean {
  const elapsed = Date.now() - lastSent[type];
  switch (type) {
    case "early_warning":
      return elapsed >= COOLDOWN_EARLY_MS;
    case "resolved":
      return elapsed >= COOLDOWN_RESOLVED_MS;
    case "siren": {
      // If early warning was already sent this cycle → longer cooldown (user already informed)
      const sirenCd =
        lastSent.early_warning > 0
          ? COOLDOWN_SIREN_AFTER_EARLY_MS
          : COOLDOWN_SIREN_MS;
      return elapsed >= sirenCd;
    }
  }
}

function markSent(type: AlertType): void {
  const now = Date.now();
  lastSent[type] = now;
  // After resolved → reset ALL others (new attack cycle)
  if (type === "resolved") {
    lastSent.early_warning = 0;
    lastSent.siren = 0;
  }
  // After siren → allow new early_warning (next wave) and resolved
  if (type === "siren") {
    lastSent.early_warning = 0;
    lastSent.resolved = 0;
  }
  // After early_warning → allow resolved
  if (type === "early_warning") lastSent.resolved = 0;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface OrefAlert {
  id: string;
  cat: string;
  title: string;
  data: string[];
  desc: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Oref Poller
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const seenAlerts = new Set<string>();

async function fetchAlerts(): Promise<OrefAlert[]> {
  const t0 = Date.now();
  try {
    const res = await fetch(config.orefApiUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "X-Requested-With": "XMLHttpRequest",
        Referer: "https://www.oref.org.il/",
        Accept: "application/json, text/plain, */*",
      },
    });

    const ms = Date.now() - t0;

    if (!res.ok) {
      logger.warn("Oref API error", { status: res.status, ms });
      return [];
    }

    const text = await res.text();
    if (!text.trim()) {
      logger.debug("Oref poll — quiet", { status: res.status, ms, raw: text });
      return [];
    }

    const parsed: unknown = JSON.parse(text);

    if (Array.isArray(parsed)) {
      logger.info("Oref poll — alerts received", {
        count: parsed.length,
        ms,
        raw: text.slice(0, 2000),
      });
      return parsed;
    }

    if (parsed && typeof parsed === "object" && "id" in parsed) {
      logger.info("Oref poll — single alert", {
        ms,
        raw: text.slice(0, 2000),
      });
      return [parsed as OrefAlert];
    }

    logger.warn("Oref unexpected response", { raw: text.slice(0, 500), ms });
    return [];
  } catch (err) {
    logger.warn("Oref fetch failed", {
      error: String(err),
      ms: Date.now() - t0,
    });
    return [];
  }
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

const CATS_SIREN = [
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
  siren: string[];
  resolved: string[];
};

const GIF_POOLS: Record<string, GifPools> = {
  funny_cats: {
    early: CATS_EARLY_WARNING,
    earlyNight: [...CATS_EARLY_WARNING, ...CATS_EARLY_WARNING_NIGHT],
    siren: CATS_SIREN,
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
    case "siren":
      return pickGif(pools.siren, `${mode}_siren`);
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
  if (!config.chatId) {
    logger.error("CHAT_ID not set — Telegram DISABLED");
    return null;
  }
  logger.info("Bot initialized", {
    chat_id: config.chatId.slice(0, -4) + "****",
    language: config.language,
    areas: config.areas,
    gif_mode: config.gifMode,
  });
  return new Bot(config.botToken);
}

function nowHHMM(): string {
  return new Date().toLocaleTimeString("he-IL", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jerusalem",
  });
}

function formatMessage(alertType: AlertType, areas: string): string {
  const time = nowHHMM();
  const localAreas = translateAreas(areas, config.language);
  const cfgKey = ALERT_TYPE_TO_CONFIG[alertType];

  const defaults = langPack.alerts[cfgKey];
  const labels = langPack.labels;

  const emoji = config.emojiOverride[cfgKey] ?? defaults.emoji;
  const title = config.titleOverride[cfgKey] ?? defaults.title;
  const desc = config.descriptionOverride[cfgKey] ?? defaults.description;

  const lines: string[] = [`<b>${emoji} ${title}</b>`];
  if (desc) lines.push(desc);
  lines.push("");
  lines.push("<blockquote>");
  lines.push(`<b>${labels.area}:</b> ${localAreas}`);

  if (alertType === "early_warning") {
    lines.push(`<b>${labels.timeToImpact}:</b> ${labels.earlyEta}`);
    lines.push(`<b>${labels.time}:</b> ${time}`);
  } else if (alertType === "siren") {
    lines.push(`<b>${labels.timeToImpact}:</b> ${labels.sirenEta}`);
    lines.push(`<b>${labels.time}:</b> ${time}`);
  } else if (alertType === "resolved") {
    lines.push(`<b>${labels.time}:</b> ${time}`);
  }
  lines.push("</blockquote>");

  // Monitoring indicator for active enrichment phases
  if (config.agent.enabled && alertType !== "resolved") {
    lines.push(labels.monitoring);
  }

  return lines.join("\n");
}

/** Send message and return {messageId, isCaption} for agent editing */
async function sendTelegram(
  alertType: AlertType,
  text: string,
  replyToMessageId?: number,
): Promise<{ messageId: number; isCaption: boolean } | null> {
  if (!bot || !config.chatId) {
    logger.error("Telegram unavailable", {
      bot_exists: !!bot,
      chat_id: config.chatId,
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
      const msg = await bot.api.sendMessage(config.chatId, text, {
        parse_mode: "HTML",
        ...replyOpts,
      });
      logger.info("Alert sent via Telegram (text)", {
        type: alertType,
        reply_to: replyToMessageId,
      });
      return { messageId: msg.message_id, isCaption: false };
    } catch (err) {
      logger.error("Telegram send failed", {
        error: String(err),
        type: alertType,
      });
      return null;
    }
  }

  // GIF mode → try animation, fall back to text
  try {
    const msg = await bot.api.sendAnimation(config.chatId, gifUrl, {
      caption: text,
      parse_mode: "HTML",
      ...replyOpts,
    });
    logger.info("Alert sent via Telegram (GIF)", {
      type: alertType,
      gif_url: gifUrl,
      reply_to: replyToMessageId,
    });
    return { messageId: msg.message_id, isCaption: true };
  } catch (err) {
    logger.warn("GIF send failed, falling back to text", {
      error: String(err),
      gif_url: gifUrl,
    });
    try {
      const msg = await bot.api.sendMessage(config.chatId, text, {
        parse_mode: "HTML",
        ...replyOpts,
      });
      logger.info("Alert sent via Telegram (text fallback)", {
        type: alertType,
        reply_to: replyToMessageId,
      });
      return { messageId: msg.message_id, isCaption: false };
    } catch (err2) {
      logger.error("Telegram send failed completely", {
        error: String(err2),
        type: alertType,
      });
      return null;
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Alert Processing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function processAlert(alert: OrefAlert): Promise<void> {
  if (!isRelevantArea(alert.data)) {
    logger.info("Alert — not in our area", {
      alert_id: alert.id,
      areas_he: alert.data,
    });
    return;
  }

  const alertType = classifyAlertType(alert.title);

  // Filter by configured alert types
  const cfgKey = ALERT_TYPE_TO_CONFIG[alertType];
  if (!config.alertTypes.includes(cfgKey)) {
    logger.info("Alert type filtered out by config", {
      alert_id: alert.id,
      type: alertType,
      config_key: cfgKey,
    });
    return;
  }

  const areas = matchedAreaLabel(alert.data);

  logger.info("Alert — RELEVANT", {
    alert_id: alert.id,
    type: alertType,
    areas_he: alert.data,
  });

  if (!shouldSend(alertType)) {
    logger.info("Cooldown active, skipping Telegram", {
      alert_id: alert.id,
      type: alertType,
    });
    return;
  }

  markSent(alertType);

  let message = formatMessage(alertType, areas);
  const alertTs = Date.now();

  // ── Reply chain + carry-forward enrichment ──
  let replyTo: number | undefined;
  if (config.agent.enabled) {
    const existingForReply = await getActiveSession();
    const shouldReply =
      existingForReply &&
      (alertType === "resolved" || existingForReply.phase !== "resolved");
    if (shouldReply) {
      replyTo = existingForReply.latestMessageId;
      const prevEnrichment = await getEnrichmentData();
      const hasData =
        prevEnrichment.origin ||
        prevEnrichment.rocketCount ||
        prevEnrichment.intercepted;
      if (hasData) {
        message = buildEnrichedMessage(
          message,
          alertType,
          alertTs,
          prevEnrichment,
          alertType !== "resolved" ? langPack.labels.monitoring : undefined,
        );
      }
    }
  }

  try {
    const sent = await sendTelegram(alertType, message, replyTo);

    // ── Session-based enrichment lifecycle ──
    if (sent && config.agent.enabled && config.chatId) {
      const existingSession = await getActiveSession();

      // Save meta for this alert (always)
      await saveAlertMeta({
        alertId: alert.id,
        messageId: sent.messageId,
        chatId: config.chatId,
        isCaption: sent.isCaption,
        alertTs,
        alertType,
        alertAreas: alert.data,
        currentText: message,
      });

      if (alertType === "resolved") {
        // ── Resolved: switch existing session to resolved phase ──
        if (existingSession) {
          // Remove monitoring indicator from previous message
          if (
            bot &&
            MONITORING_RE.test(existingSession.currentText)
          ) {
            const cleaned = stripMonitoring(existingSession.currentText);
            try {
              if (existingSession.isCaption) {
                await bot.api.editMessageCaption(
                  existingSession.chatId,
                  existingSession.latestMessageId,
                  { caption: cleaned, parse_mode: "HTML" },
                );
              } else {
                await bot.api.editMessageText(
                  existingSession.chatId,
                  existingSession.latestMessageId,
                  cleaned,
                  { parse_mode: "HTML" },
                );
              }
            } catch {
              // Best-effort: ignore edit failures
            }
          }

          const updated: ActiveSession = {
            ...existingSession,
            phase: "resolved",
            phaseStartTs: Date.now(),
            latestAlertId: alert.id,
            latestMessageId: sent.messageId,
            latestAlertTs: alertTs,
            isCaption: sent.isCaption,
            currentText: message,
          };
          await setActiveSession(updated);
          const delay = PHASE_ENRICH_DELAY_MS.resolved;
          await enqueueEnrich(alert.id, alertTs, delay);
          logger.info("Session: entered resolved phase", {
            sessionId: existingSession.sessionId,
            alertId: alert.id,
          });
        } else {
          logger.info("Resolved alert without active session — no enrichment", {
            alert_id: alert.id,
          });
        }
      } else {
        // ── Early warning / Siren ──
        if (existingSession && existingSession.phase !== "resolved") {
          // Upgrade session phase (early → siren, or same-type refresh)
          // Remove monitoring indicator from previous message
          if (
            bot &&
            existingSession.latestMessageId !== sent.messageId &&
            MONITORING_RE.test(existingSession.currentText)
          ) {
            const cleaned = stripMonitoring(existingSession.currentText);
            try {
              if (existingSession.isCaption) {
                await bot.api.editMessageCaption(
                  existingSession.chatId,
                  existingSession.latestMessageId,
                  { caption: cleaned, parse_mode: "HTML" },
                );
              } else {
                await bot.api.editMessageText(
                  existingSession.chatId,
                  existingSession.latestMessageId,
                  cleaned,
                  { parse_mode: "HTML" },
                );
              }
            } catch {
              // Best-effort
            }
          }
          const updated: ActiveSession = {
            ...existingSession,
            phase: alertType,
            phaseStartTs: Date.now(),
            latestAlertId: alert.id,
            latestMessageId: sent.messageId,
            latestAlertTs: alertTs,
            isCaption: sent.isCaption,
            currentText: message,
            alertAreas: alert.data,
          };
          await setActiveSession(updated);
          logger.info("Session: upgraded phase", {
            sessionId: existingSession.sessionId,
            from: existingSession.phase,
            to: alertType,
            alertId: alert.id,
          });
        } else {
          // New session (or previous one was in resolved — start fresh)
          if (existingSession) {
            await clearSession();
          }
          const session: ActiveSession = {
            sessionId: alert.id,
            sessionStartTs: alertTs,
            phase: alertType,
            phaseStartTs: alertTs,
            latestAlertId: alert.id,
            latestMessageId: sent.messageId,
            latestAlertTs: alertTs,
            chatId: config.chatId,
            isCaption: sent.isCaption,
            currentText: message,
            alertAreas: alert.data,
          };
          await setActiveSession(session);
          logger.info("Session: started", {
            sessionId: alert.id,
            phase: alertType,
          });
        }

        const delay = PHASE_INITIAL_DELAY_MS[alertType];
        await enqueueEnrich(alert.id, alertTs, delay);
      }
    }
  } catch (err) {
    logger.error("Alert send/store failed", {
      error: String(err),
      alert_id: alert.id,
    });
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Health Server
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function startHealthServer(): void {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          service: "easyoref",
          uptime: process.uptime(),
          seen_alerts: seenAlerts.size,
          language: config.language,
          gif_mode: config.gifMode,
          areas: config.areas,
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
    language: config.language,
    gif_mode: config.gifMode,
    areas: config.areas,
  });

  await initTranslations();

  // Resolve YAML city_ids → Hebrew area names for Oref API matching
  if (config.cityIds.length > 0) {
    config.areas = resolveCityIds(config.cityIds);
    logger.info("Resolved city IDs to area names", {
      city_ids: config.cityIds,
      areas: config.areas,
    });
  } else if (process.env.AREAS) {
    // Legacy fallback: AREAS env var (comma-separated Hebrew names)
    config.areas = process.env.AREAS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    logger.info("Using legacy AREAS env var", { areas: config.areas });
  }

  if (config.areas.length === 0) {
    logger.warn("No areas configured — bot will not filter alerts by area");
  }

  initGifState(config.dataDir);
  bot = initBot();
  startHealthServer();

  // Start agent subsystems if enabled
  if (config.agent.enabled) {
    startEnrichWorker();
    await startMonitor();
    logger.info("Agent subsystems started", {
      filterModel: config.agent.filterModel,
      provider: "openrouter.ai",
      channels: 14, // MONITORED_CHANNELS length (hardcoded)
      enrich_delay_ms: config.agent.enrichDelayMs,
    });
  }

  // Poll loop
  setInterval(async () => {
    try {
      const alerts = await fetchAlerts();
      for (const alert of alerts) {
        if (seenAlerts.has(alert.id)) continue;
        seenAlerts.add(alert.id);
        await processAlert(alert);
      }
    } catch (err) {
      logger.error("Poll error", { error: String(err) });
    }
  }, config.pollIntervalMs);

  // Heartbeat — flush Logtail buffer every 30s
  setInterval(async () => {
    logger.debug("heartbeat", {
      uptime_s: Math.round(process.uptime()),
      seen_alerts: seenAlerts.size,
    });
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
