/**
 * BullMQ worker — processes "enrich-alert" jobs.
 *
 * Session-aware scheduling:
 *   early_warning → every 20s, up to 30 min
 *   siren         → every 20s, up to 15 min
 *   resolved      → every 60s, up to 10 min (tail — detailed intel)
 *
 * After each job, checks the session phase and re-enqueues
 * with the appropriate delay. Stops when phase expires.
 */

import { Bot } from "grammy";
import { Worker } from "bullmq";
import { config } from "../config.js";
import { getLanguagePack } from "../i18n.js";
import * as logger from "../logger.js";
import { runEnrichment } from "./graph.js";
import { MONITORING_RE, stripMonitoring } from "./message.js";
import { enqueueEnrich } from "./queue.js";
import type { EnrichJobData } from "./queue.js";
import {
  clearSession,
  getActiveSession,
  isPhaseExpired,
  PHASE_ENRICH_DELAY_MS,
} from "./store.js";

let _worker: Worker | null = null;

/** Remove ⏳ monitoring indicator from the last message */
async function removeMonitoringIndicator(session: {
  chatId: string;
  latestMessageId: number;
  isCaption: boolean;
  currentText: string;
}): Promise<void> {
  if (!config.botToken || !MONITORING_RE.test(session.currentText)) return;
  const cleaned = stripMonitoring(session.currentText);
  try {
    const tgBot = new Bot(config.botToken);
    if (session.isCaption) {
      await tgBot.api.editMessageCaption(
        session.chatId,
        session.latestMessageId,
        { caption: cleaned, parse_mode: "HTML" },
      );
    } else {
      await tgBot.api.editMessageText(
        session.chatId,
        session.latestMessageId,
        cleaned,
        { parse_mode: "HTML" },
      );
    }
    logger.info("Removed monitoring indicator", {
      messageId: session.latestMessageId,
    });
  } catch (err) {
    const errStr = String(err);
    if (!errStr.includes("message is not modified")) {
      logger.error("Failed to remove monitoring indicator", {
        error: errStr,
      });
    }
  }
}

export function startEnrichWorker(): void {
  if (!config.agent.enabled) return;

  const connection = {
    host: new URL(config.agent.redisUrl).hostname,
    port: Number(new URL(config.agent.redisUrl).port || 6379),
    password: new URL(config.agent.redisUrl).password || undefined,
  };

  _worker = new Worker<EnrichJobData>(
    "enrich-alert",
    async (job) => {
      const { alertId } = job.data;
      logger.info("Enrich worker: processing job", { alertId, jobId: job.id });

      const session = await getActiveSession();
      if (!session) {
        logger.info("Enrich worker: no active session — skipping", { alertId });
        return;
      }

      // Phase expired → end session
      if (isPhaseExpired(session)) {
        logger.info("Enrich worker: phase expired — ending session", {
          alertId: session.latestAlertId,
          phase: session.phase,
        });
        await removeMonitoringIndicator(session);
        await clearSession();
        return;
      }

      const langPack = getLanguagePack(config.language);

      // Run enrichment using latest alert's message as edit target
      await runEnrichment({
        alertId: session.latestAlertId,
        alertTs: session.latestAlertTs,
        alertType: session.phase,
        alertAreas: session.alertAreas,
        chatId: session.chatId,
        messageId: session.latestMessageId,
        isCaption: session.isCaption,
        currentText: session.baseText ?? session.currentText,
        monitoringLabel: langPack.labels.monitoring,
      });

      // Re-check session after enrichment (may have changed phase)
      const after = await getActiveSession();
      if (!after) return;

      if (isPhaseExpired(after)) {
        logger.info(
          "Enrich worker: phase expired post-enrich — ending session",
          {
            phase: after.phase,
          },
        );
        await removeMonitoringIndicator(after);
        await clearSession();
        return;
      }

      // Re-enqueue with phase-appropriate delay
      const delay = PHASE_ENRICH_DELAY_MS[after.phase];
      await enqueueEnrich(after.latestAlertId, after.latestAlertTs, delay);
    },
    {
      connection,
      concurrency: 1,
    },
  );

  _worker.on("completed", (job) => {
    logger.info("Enrich worker: job completed", { jobId: job.id });
  });

  _worker.on("failed", (job, err) => {
    logger.error("Enrich worker: job failed", {
      jobId: job?.id,
      error: String(err),
    });
  });

  logger.info("Enrich worker started");
}

export async function stopEnrichWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = null;
  }
}
