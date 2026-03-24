/**
 * EasyOref Logger
 *
 * Dual-output: console (always) + Better Stack Logtail (if token set).
 * Token source: config.yaml `observability.betterstack_token` or LOGTAIL_TOKEN env.
 * Live Tail: https://logs.betterstack.com → your source → "Live Tail"
 */

import { Logtail } from "@logtail/node";
import { config } from "@easyoref/shared";

const token = config.logtailToken;
const logtail = token ? new Logtail(token) : null;

const base = {
  service: "easyoref",
  env: process.env.NODE_ENV ?? "production",
};

if (logtail) {
  console.log(
    "📡 Better Stack Logtail enabled — live tail at logs.betterstack.com",
  );
} else {
  console.log("📟 LOGTAIL_TOKEN not set — logging to console only");
}

// ── Public API ────────────────────────────────────────────────────────────────

export function info(message: string, ctx?: Record<string, unknown>): void {
  console.log(message, ctx ?? "");
  logtail?.info(message, { ...base, ...ctx });
}

export function warn(message: string, ctx?: Record<string, unknown>): void {
  console.warn(message, ctx ?? "");
  logtail?.warn(message, { ...base, ...ctx });
}

export function error(message: string, ctx?: Record<string, unknown>): void {
  console.error(message, ctx ?? "");
  logtail?.error(message, { ...base, ...ctx });
}

export function debug(message: string, ctx?: Record<string, unknown>): void {
  if (process.env.LOG_LEVEL === "debug") {
    console.debug(message, ctx ?? "");
  }
  logtail?.debug(message, { ...base, ...ctx });
}

/** Call before process.exit() — flushes Logtail buffer */
export async function flush(): Promise<void> {
  await logtail?.flush();
}
