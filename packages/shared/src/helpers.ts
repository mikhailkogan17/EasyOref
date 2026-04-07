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

/**
 * Fetch full alert history from alerts-history.oref.org.il (full-day, not just last 120s).
 * AlertsHistory.json only contains currently-active alerts; GetAlarmsHistory.aspx has the full day.
 *
 * NOTE: API is flaky (~50% empty responses) and has a hard 3000-entry cap with no pagination.
 * Retries up to 2 times on empty response to mitigate flakiness.
 */
export async function fetchOrefHistory(
  timeoutMs = 5000,
): Promise<OrefHistoryEntry[]> {
  const d = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }),
  );
  const today = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`; // DD.MM.YYYY
  const url = `https://alerts-history.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&fromDate=${today}&toDate=${today}&mode=0`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Referer: "https://www.oref.org.il/",
          "X-Requested-With": "XMLHttpRequest",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.106 Safari/537.36",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        return [];
      }
      const raw: unknown = await res.json();
      if (!Array.isArray(raw) || raw.length === 0) {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        return [];
      }
      // Map category_desc → title for compatibility with existing consumers
      return raw.map(
        (e: {
          alertDate: string;
          category_desc: string;
          data: string;
          category: number;
        }) => ({
          alertDate: e.alertDate,
          title: e.category_desc,
          data: e.data,
          category: e.category,
        }),
      );
    } catch {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      return [];
    }
  }
  return [];
}
