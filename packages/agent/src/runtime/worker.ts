/**
 * BullMQ worker — processes "enrich-alert" jobs.
 *
 * Session-aware scheduling with configurable run limit:
 *   Run 1: after initial delay (phase-dependent, from config)
 *   Run 2: after phase interval (from config)
 *   Run 3+: up to config.agent.maxEnrichRuns (default 3)
 *
 * After max runs or phase expiry, the session ends.
 * All timing values are configurable via YAML config.
 */

import {
  clearSession,
  config,
  getActiveSession,
  isPhaseExpired,
  PHASE_ENRICH_DELAY_MS,
  setLastUpdateTs,
  type TelegramMessageType as TelegramMessage,
} from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import { Worker } from "bullmq";
import { runEnrichment } from "../graphs/enrichment/enrichment-graph.js";
import { enqueueEnrich, enrichQueueName, type EnrichJobData } from "./queue.js";

/** In-memory run counter per session (keyed by sessionId). */
const sessionRunCount = new Map<string, number>();

let _worker: Worker | undefined = undefined;

/** Fire-and-forget OpenRouter reachability check at startup */
function checkOpenRouterConnectivity(): void {
  fetch("https://openrouter.ai/api/v1/models", {
    method: "HEAD",
    signal: AbortSignal.timeout(5000),
  })
    .then((res) => {
      logger.info("OpenRouter connectivity check passed", {
        status: res.status,
      });
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
        sessionRunCount.delete(session.sessionId);
        await clearSession();
        return;
      }

      // Track run count
      const runNum = (sessionRunCount.get(session.sessionId) ?? 0) + 1;
      sessionRunCount.set(session.sessionId, runNum);

      const maxRuns = config.agent.maxEnrichRuns;

      if (runNum > maxRuns) {
        logger.info("Enrich worker: max runs reached — ending session", {
          alertId: session.latestAlertId,
          phase: session.phase,
          runNum,
        });
        sessionRunCount.delete(session.sessionId);
        await clearSession();
        return;
      }

      logger.info("Enrich worker: starting run", {
        alertId: session.latestAlertId,
        phase: session.phase,
        runNum,
        maxRuns,
      });

      // Build telegramMessages array for RunEnrichmentInput
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

      // Advance watermark
      await setLastUpdateTs(Date.now());

      // Re-check session after enrichment
      const after = await getActiveSession();
      if (!after) {
        sessionRunCount.delete(session.sessionId);
        return;
      }

      if (isPhaseExpired(after)) {
        logger.info(
          "Enrich worker: phase expired post-enrich — ending session",
          {
            phase: after.phase,
          },
        );
        sessionRunCount.delete(after.sessionId);
        await clearSession();
        return;
      }

      // Only re-enqueue if under run limit
      if (runNum < maxRuns) {
        const delay = PHASE_ENRICH_DELAY_MS[after.phase];
        await enqueueEnrich(after.latestAlertId, after.latestAlertTs, delay);
      } else {
        logger.info("Enrich worker: final run completed — no re-enqueue", {
          alertId: after.latestAlertId,
          phase: after.phase,
        });
      }
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
    logger.error("Enrich worker: job FAILED → DLQ", {
      jobId: job?.id,
      alertId: job?.data?.alertId,
      alertTs: job?.data?.alertTs,
      attempt: job?.attemptsMade,
      maxAttempts: job?.opts?.attempts,
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
