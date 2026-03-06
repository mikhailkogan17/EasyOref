/**
 * BullMQ queue — enrich alert jobs.
 *
 * Job payload: { alertId, alertTs }
 * Job is added with a delay (config.agent.enrichDelayMs) after alert fires,
 * then the worker runs the LangGraph pipeline and edits the Telegram message.
 */

import { Queue } from "bullmq";
import { config } from "../config.js";
import * as logger from "../logger.js";

export interface EnrichJobData {
  alertId: string;
  alertTs: number;
}

let _queue: Queue<EnrichJobData> | null = null;

export function getEnrichQueue(): Queue<EnrichJobData> {
  if (!_queue) {
    _queue = new Queue<EnrichJobData>("enrich-alert", {
      connection: {
        host: new URL(config.agent.redisUrl).hostname,
        port: Number(new URL(config.agent.redisUrl).port || 6379),
        password: new URL(config.agent.redisUrl).password || undefined,
      },
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 2,
        backoff: { type: "exponential", delay: 10_000 },
      },
    });
  }
  return _queue;
}

export async function enqueueEnrich(
  alertId: string,
  alertTs: number,
): Promise<void> {
  if (!config.agent.enabled) return;

  const queue = getEnrichQueue();
  await queue.add(
    "enrich",
    { alertId, alertTs },
    { delay: config.agent.enrichDelayMs },
  );
  logger.info("Enrich job enqueued", {
    alertId,
    delay_ms: config.agent.enrichDelayMs,
  });
}
