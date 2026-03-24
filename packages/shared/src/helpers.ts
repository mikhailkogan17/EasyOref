/** Shared utility functions for the agent subsystem. */

import { createHash } from "node:crypto";

/** Format timestamp as HH:MM Israel time */
export function toIsraelTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("he-IL", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jerusalem",
  });
}

/** MD5 hash for dedup */
export function textHash(text: string): string {
  return createHash("md5").update(text).digest("hex");
}
