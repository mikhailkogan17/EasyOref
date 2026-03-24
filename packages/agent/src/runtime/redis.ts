/**
 * Redis singleton (ioredis).
 * Lazily initialized so the main bot still works when agent.enabled=false.
 */

import * as logger from "@easyoref/monitoring";
import { config } from "@easyoref/shared";
import { Redis as IORedis } from "ioredis";

let _redis: IORedis | undefined = undefined;

export function getRedis(): IORedis {
  if (!_redis) {
    _redis = new IORedis(config.agent.redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });

    _redis.on("error", (err: Error) => {
      logger.warn("Redis error", { error: String(err) });
    });

    _redis.on("connect", () => {
      logger.info("Redis connected", {
        url: config.agent.redisUrl.replace(/:[^:@]+@/, ":***@"),
      });
    });
  }
  return _redis;
}

export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = undefined;
  }
}
