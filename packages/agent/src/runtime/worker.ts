/**
 * BullMQ worker — processes "enrich-alert" jobs.
 *
 * Session-aware scheduling:
 *   early_warning → every 20s, up to 30 min
 *   red_alert     → every 20s, up to 15 min
 *   resolved      → every 60s, up to 10 min (tail — detailed intel)
 *
 * After each job, checks the session phase and re-enqueues
 * with the appropriate delay. Stops when phase expires.
 */

import * as logger from "@easyoref/monitoring";
import {
  clearSession,
  config,
  getActiveSession,
  isPhaseExpired,
  PHASE_ENRICH_DELAY_MS,
  setLastUpdateTs,
  type TelegramMessageType as TelegramMessage,
} from "@easyoref/shared";
import { Worker } from "bullmq";
import { runEnrichment } from "../graph.js";
import { enqueueEnrich, enrichQueueName, type EnrichJobData } from "./queue.js";

let _worker: Worker | undefined = undefined;

/** Fire-and-forget OpenRouter reachability check at startup */
function checkOpenRouterConnectivity(): void {
  fetch("https://openrouter.ai/api/v1/models", {
    method: "HEAD",
    signal: AbortSignal.timeout(5000),
  })
    .then((res) => {
      logger.info("OpenRouter connectivity check passed", { status: res.status });
    })
    .catch((err) => {
      logger.warn("OpenRouter connectivity check FAILED — LLM calls may fail", {
        error: String(err),
      });
    });
}

export function startEnrichWorker(): void {
  if (!config.agent.enabled) return;

  checkOpenRouterConnectivity();

  const connection = {
    host: new URL(config.agent.redisUrl).hostname,
    port: Number(new URL(config.agent.redisUrl).port || 6379),
    password: new URL(config.agent.redisUrl).password || undefined,
  };

  _worker = new Worker<EnrichJobData>(
    enrichQueueName(),
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
        await clearSession();
        return;
      }

      // Run enrichment using latest alert's message as edit target
      // Fallback: if session.telegramMessages is undefined (legacy sessions),
      // build the array from the primary chat fields so RunEnrichmentInput
      // schema validation always receives a non-undefined array.
      const telegramMessages: TelegramMessage[] = session.telegramMessages ?? [
        {
          chatId: session.chatId,
          messageId: session.latestMessageId,
          isCaption: session.isCaption,
        },
      ];
      await runEnrichment({
        alertId: session.latestAlertId,
        alertTs: session.latestAlertTs,
        alertType: session.phase,
        alertAreas: session.alertAreas,
        chatId: session.chatId,
        messageId: session.latestMessageId,
        isCaption: session.isCaption,
        telegramMessages,
        currentText: session.baseText ?? session.currentText,
      });

      // Advance watermark so the next job only processes posts arriving after this point.
      // Without this, buildTracking() never classifies posts as "previous", and
      // the extract-node's URL dedup filters out all channels on subsequent runs.
      await setLastUpdateTs(Date.now());

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
      stack: err instanceof Error ? err.stack : undefined,
    });
  });

  logger.info("Enrich worker started");
}

export async function stopEnrichWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = undefined;
  }
}
