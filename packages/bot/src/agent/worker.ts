/**
 * BullMQ worker — processes "enrich-alert" jobs.
 *
 * Started alongside the bot when agent.enabled=true.
 * Picks up jobs from the queue after the enrichDelayMs delay,
 * fetches alert meta from Redis, runs LangGraph enrichment.
 */

import { Worker } from "bullmq";
import { config } from "../config.js";
import * as logger from "../logger.js";
import { runEnrichment } from "./graph.js";
import { enqueueEnrich } from "./queue.js";
import type { EnrichJobData } from "./queue.js";
import { getActiveAlert, getAlertMeta } from "./store.js";

let _worker: Worker | null = null;

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
      const { alertId, alertTs } = job.data;
      logger.info("Enrich worker: processing job", { alertId, jobId: job.id });

      const meta = await getAlertMeta(alertId);
      if (!meta) {
        logger.warn("Enrich worker: alert meta not found — skipping", {
          alertId,
        });
        return;
      }

      await runEnrichment({
        alertId,
        alertTs,
        alertType: meta.alertType,
        alertAreas: meta.alertAreas ?? [],
        chatId: meta.chatId,
        messageId: meta.messageId,
        isCaption: meta.isCaption,
        currentText: meta.currentText ?? "",
      });

      // Re-enqueue if alert is still active (loop every enrichDelayMs)
      const still = await getActiveAlert();
      if (still && still.alertId === alertId) {
        await enqueueEnrich(alertId, alertTs);
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
