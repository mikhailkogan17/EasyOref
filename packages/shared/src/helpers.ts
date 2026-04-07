/** Shared utility functions for the agent subsystem. */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// pikud-haoref-api: battle-tested CJS library for Oref API
// Handles UTF-16-LE/UTF-8 BOM detection, proper headers, cache-busting, encoding
const pikudHaoref = require("pikud-haoref-api") as {
  getActiveAlerts: (
    callback: (err: Error | null, alerts?: PikudAlert[]) => void,
    options?: { alertsHistoryJson?: boolean; proxy?: string },
  ) => void;
};

// ── Types ────────────────────────────────────────────

/** Alert as returned by pikud-haoref-api. */
export interface PikudAlert {
  type: string; // 'missiles' | 'general' | 'earthQuake' | etc.
  cities: string[]; // Hebrew area names
  instructions?: string; // alert title (from Alerts.json; absent in history fallback)
  id?: string; // unique ID (from Alerts.json only)
}

/** Entry from GetAlarmsHistory.aspx (full-day history). */
export interface OrefHistoryEntry {
  alertDate: string;
  title: string; // mapped from category_desc
  data: string; // single city name
  category: number;
}

// ── Helpers ──────────────────────────────────────────

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

// ── Oref API wrappers (via pikud-haoref-api) ─────────

/**
 * Fetch active alerts via pikud-haoref-api.
 * Handles encoding (UTF-16-LE/UTF-8 BOM), proper headers, auto-fallback to history.
 */
export async function fetchActiveAlerts(
  timeoutMs = 5000,
): Promise<PikudAlert[]> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), timeoutMs);
    pikudHaoref.getActiveAlerts((err, alerts) => {
      clearTimeout(timer);
      if (err || !alerts) return resolve([]);
      resolve(alerts);
    });
  });
}

// ── TzevaAdom alert history API ──────────────────────

/** Single alert within an attack wave from TzevaAdom API. */
export interface TzevaAdomAlert {
  time: number; // unix timestamp (seconds)
  cities: string[]; // Hebrew city names
  threat: number; // 0 = rockets, 5 = hostile aircraft infiltration
  isDrill: boolean;
}

/** Attack wave from TzevaAdom API. */
export interface TzevaAdomWave {
  id: number;
  description: string | null;
  alerts: TzevaAdomAlert[];
}

/**
 * Fetch alert history from api.tzevaadom.co.il.
 * Always available, returns grouped attack waves (newest first).
 * Throws on network/parse error (caller must handle).
 */
export async function fetchTzevaAdomHistory(
  timeoutMs = 10000,
): Promise<TzevaAdomWave[]> {
  const res = await fetch("https://api.tzevaadom.co.il/alerts-history/", {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`TzevaAdom API returned ${res.status}`);
  }
  const raw: unknown = await res.json();
  if (!Array.isArray(raw)) {
    throw new Error("TzevaAdom API returned non-array");
  }
  return raw as TzevaAdomWave[];
}
