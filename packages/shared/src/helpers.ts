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
const pikudHaorefConfig = require("pikud-haoref-api/config") as {
  hfc: {
    alertsHistory: { api: string };
    alerts: { api: string };
  };
};

// ── Types ────────────────────────────────────────────

/** Alert as returned by pikud-haoref-api. */
export interface PikudAlert {
  type: string; // 'missiles' | 'general' | 'earthQuake' | etc.
  cities: string[]; // Hebrew area names
  instructions?: string; // alert title (from Alerts.json; absent in history fallback)
  id?: string; // unique ID (from Alerts.json only)
}

/** Raw entry from AlertsHistory.json (unfiltered). */
export interface OrefHistoryEntry {
  alertDate: string;
  title: string;
  data: string; // single city name (NOT array)
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

/**
 * Fetch full alert history from Oref AlertsHistory.json (no 120s filter).
 * pikud-haoref-api hard-filters to last 120s — we need the full dataset for Q&A.
 * URL sourced from pikud-haoref-api/config. Headers match the library's approach.
 */
export async function fetchOrefHistory(
  timeoutMs = 5000,
): Promise<OrefHistoryEntry[]> {
  const url = `${pikudHaorefConfig.hfc.alertsHistory.api}?${Date.now()}`;
  try {
    const res = await fetch(url, {
      headers: {
        Pragma: "no-cache",
        "Cache-Control": "max-age=0",
        Referer: "https://www.oref.org.il/11226-he/pakar.aspx",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.106 Safari/537.36",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    // Handle encoding (BOM detection) matching pikud-haoref-api's approach
    const buf = Buffer.from(await res.arrayBuffer());
    let text: string;
    if (buf[0] === 0xff && buf[1] === 0xfe) {
      text = buf.toString("utf16le").replace(/^\uFEFF/, "");
    } else if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      text = buf.toString("utf8").replace(/^\uFEFF/, "");
    } else {
      text = buf.toString("utf8");
    }
    text = text.replace(/\0/g, "");
    if (!text.trim()) return [];
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data)) return [];
    return data;
  } catch {
    return [];
  }
}
