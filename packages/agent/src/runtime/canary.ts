/**
 * Canary mode — synthetic alert self-test on startup.
 *
 * When `config.canary: true` (YAML), enqueues a synthetic test alert
 * through the enrichment pipeline to verify end-to-end health.
 * The synthetic alert uses a special alertId prefix "canary-" so the
 * edit node skips Telegram API calls.
 */

import { config } from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import { runEnrichment } from "../graphs/enrichment/enrichment-graph.js";
import { CANARY_ALERT_PREFIX } from "../graphs/enrichment/nodes/edit.js";

export { CANARY_ALERT_PREFIX };

/**
 * Run a synthetic enrichment pipeline to verify system health.
 * Returns true if pipeline completed without throwing.
 */
export async function runCanary(): Promise<boolean> {
  if (!config.agent.enabled) {
    logger.info("canary: agent not enabled — skipping");
    return true;
  }

  const canaryId = `${CANARY_ALERT_PREFIX}${Date.now()}`;
  logger.info("canary: starting synthetic enrichment", { canaryId });

  try {
    await runEnrichment({
      alertId: canaryId,
      alertTs: Date.now(),
      alertType: "red_alert",
      alertAreas: ["תל אביב - דרום העיר ויפו"],
      chatId: "0", // dummy — edit node will skip
      messageId: 0,
      isCaption: false,
      telegramMessages: [],
      currentText: "[CANARY] Synthetic test alert",
    });

    logger.info("canary: pipeline completed successfully", { canaryId });
    return true;
  } catch (err) {
    logger.error("canary: pipeline FAILED — system may be unhealthy", {
      canaryId,
      error: String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return false;
  }
}
