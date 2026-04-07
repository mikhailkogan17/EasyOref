/**
 * get_last_attack tool — finds the LAST attack in Oref history for the user's configured zones.
 *
 * Returns a structured object:
 *   zone       — specific Oref zone name (English)
 *   zone_he    — specific Oref zone name (Hebrew)
 *   area       — region (e.g. "גוש דן (Gush Dan)")
 *   macro      — macro region ("מרכז (Center)" / "צפון (North)" / "דרום (South)")
 *   early_time — HH:MM of early warning (category 14), or null
 *   siren_times — HH:MM[] of rocket sirens (category 1)
 *   resolved_time — HH:MM of incident resolved (category 13), or null
 *   earliest_available — HH:MM of the earliest entry (API has 3000-entry hard cap)
 *
 * Also checks fetchActiveAlerts() for "is there an attack right now?"
 */

import type { GeoMetadata, OrefHistoryEntry } from "@easyoref/shared";
import {
  config,
  fetchActiveAlerts,
  resolveCityIds,
  translateAreas,
  ZONE_HIERARCHY,
} from "@easyoref/shared";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

/** Extract HH:MM from alertDate string like "2026-04-07T18:16:00" or fallback. */
function toHHMM(alertDate: string): string {
  if (alertDate.includes("T")) {
    return alertDate.split("T")[1]?.slice(0, 5) ?? alertDate;
  }
  return alertDate;
}

/** Geo metadata for a Hebrew zone name. */
function getGeo(zoneName: string): {
  zone_he: string;
  zone_en: string;
  area: string;
  macro: string;
} {
  const meta: GeoMetadata | undefined =
    ZONE_HIERARCHY[zoneName as keyof typeof ZONE_HIERARCHY];
  return {
    zone_he: zoneName,
    zone_en: translateAreas(zoneName, "en"),
    area: meta?.area
      ? `${meta.area} (${translateAreas(meta.area, "en")})`
      : "unknown",
    macro: meta?.macro
      ? `${meta.macro} (${translateAreas(meta.macro, "en")})`
      : "unknown",
  };
}

/**
 * Find the LAST attack for a set of zone names.
 *
 * Attack = sequence of: early_warning (cat 14) → siren (cat 1) → resolved (cat 13).
 * We find the last siren, then look backwards for early_warning and forward for resolved.
 */
export function findLastAttack(
  history: OrefHistoryEntry[],
  zoneNames: string[],
): {
  zone: ReturnType<typeof getGeo>;
  early_time: string | null;
  siren_times: string[];
  resolved_time: string | null;
} | null {
  const zoneSet = new Set(zoneNames);

  // Filter to our zones only
  const ours = history.filter((e) => zoneSet.has(e.data));
  if (ours.length === 0) return null;

  // Sort by alertDate ascending (oldest first)
  const sorted = [...ours].sort(
    (a, b) => new Date(a.alertDate).getTime() - new Date(b.alertDate).getTime(),
  );

  // Find the LAST siren (category 1) — that's our attack anchor
  let lastSirenIdx = -1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i]!.category === 1) {
      lastSirenIdx = i;
      break;
    }
  }

  if (lastSirenIdx === -1) {
    // No sirens — check for early_warning only (attack in progress, no siren yet)
    const lastEarly = [...sorted].reverse().find((e) => e.category === 14);
    if (lastEarly) {
      return {
        zone: getGeo(lastEarly.data),
        early_time: toHHMM(lastEarly.alertDate),
        siren_times: [],
        resolved_time: null,
      };
    }
    return null;
  }

  const lastSiren = sorted[lastSirenIdx]!;
  const sirenTs = new Date(lastSiren.alertDate).getTime();

  // Collect ALL siren times within 30 min window around the last siren (same attack wave)
  const WAVE_WINDOW_MS = 30 * 60 * 1000;
  const sirenTimes: string[] = [];
  const seenTimes = new Set<string>();
  for (const e of sorted) {
    if (e.category !== 1) continue;
    const ts = new Date(e.alertDate).getTime();
    if (Math.abs(ts - sirenTs) <= WAVE_WINDOW_MS) {
      const hhmm = toHHMM(e.alertDate);
      if (!seenTimes.has(hhmm)) {
        seenTimes.add(hhmm);
        sirenTimes.push(hhmm);
      }
    }
  }

  // Look for early_warning (cat 14) before the first siren in this wave (within 15 min)
  const firstSirenMinutes = Math.min(
    ...sirenTimes.map((t) => {
      const [h, m] = t.split(":").map(Number);
      return h! * 60 + m!;
    }),
  );
  let earlyTime: string | null = null;
  for (const e of sorted) {
    if (e.category !== 14) continue;
    const hhmm = toHHMM(e.alertDate);
    const [h, m] = hhmm.split(":").map(Number);
    const mins = h! * 60 + m!;
    if (mins <= firstSirenMinutes && firstSirenMinutes - mins <= 15) {
      earlyTime = hhmm;
      break;
    }
  }

  // Look for resolved (cat 13) after the last siren (within 30 min)
  let resolvedTime: string | null = null;
  for (let i = lastSirenIdx + 1; i < sorted.length; i++) {
    const e = sorted[i]!;
    if (e.category !== 13) continue;
    const ts = new Date(e.alertDate).getTime();
    if (ts - sirenTs <= WAVE_WINDOW_MS) {
      resolvedTime = toHHMM(e.alertDate);
      break;
    }
  }

  return {
    zone: getGeo(lastSiren.data),
    early_time: earlyTime,
    siren_times: sirenTimes,
    resolved_time: resolvedTime,
  };
}

/**
 * Create the get_last_attack tool.
 * Takes pre-fetched history (from context node) to avoid flaky re-fetch.
 */
export function createGetLastAttackTool(history: OrefHistoryEntry[]) {
  return tool(
    async () => {
      const configNames = resolveCityIds(config.cityIds);

      // 1. Check if there's an active attack RIGHT NOW
      const active = await fetchActiveAlerts().catch(() => []);
      const activeInZone = active.filter((a) =>
        a.cities.some((c) => configNames.includes(c)),
      );

      // 2. Find last attack in history
      const lastAttack = findLastAttack(history, configNames);

      // 3. Earliest available timestamp (API 3000-entry cap info)
      let earliestAvailable: string | null = null;
      if (history.length > 0) {
        const allSorted = [...history].sort(
          (a, b) =>
            new Date(a.alertDate).getTime() - new Date(b.alertDate).getTime(),
        );
        earliestAvailable = toHHMM(allSorted[0]!.alertDate);
      }

      const result: Record<string, unknown> = {};

      if (activeInZone.length > 0) {
        result.active_attack = true;
        result.active_areas = activeInZone.flatMap((a) =>
          a.cities.map((c) => translateAreas(c, "en")),
        );
      } else {
        result.active_attack = false;
      }

      if (lastAttack) {
        result.last_attack = {
          zone: lastAttack.zone.zone_en,
          zone_he: lastAttack.zone.zone_he,
          area: lastAttack.zone.area,
          macro: lastAttack.zone.macro,
          early_time: lastAttack.early_time,
          siren_times: lastAttack.siren_times,
          resolved_time: lastAttack.resolved_time,
        };
      } else {
        result.last_attack = null;
      }

      result.earliest_available = earliestAvailable;
      result.history_entries = history.length;
      if (history.length >= 3000) {
        result.truncated = true;
        result.note =
          "API returned 3000 entries (hard cap). Earlier attacks may be missing. " +
          `Earliest available entry: ${earliestAvailable}`;
      }

      return JSON.stringify(result);
    },
    {
      name: "get_last_attack",
      description:
        "Get the last attack in the user's configured area. " +
        "Returns: active_attack (bool), last_attack (zone, area, macro, early_time, siren_times, resolved_time), " +
        "and earliest_available timestamp. " +
        "ALWAYS call this tool first when asked about sirens, attacks, or current situation.",
      schema: z.object({}),
    },
  );
}
