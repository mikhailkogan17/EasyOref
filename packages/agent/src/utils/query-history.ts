/**
 * query_alert_history tool — deterministic Oref history query.
 *
 * LLM calls this with explicit zone_id + category integers.
 * Tool does the filtering/counting; LLM never parses raw JSON arrays.
 *
 * zone_id=0  → aggregate all configured zones (user's area)
 * zone_id=N  → single area from CONFIGURED_ZONES list
 * category=0 → all alert types
 * category=N → specific category (1=siren, 13=resolved, etc.)
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { config, resolveCityIds, translateAreas } from "@easyoref/shared";
import type { OrefHistoryEntry } from "@easyoref/shared";

export const CATEGORY_EN: Record<number, string> = {
  1: "Rocket/missile fire (siren)",
  2: "Hostile aircraft (siren)",
  3: "Unconventional weapon",
  4: "Earthquake",
  5: "Radiological event",
  6: "Terrorist infiltration",
  7: "Tsunami",
  9: "Hazardous materials",
  10: "Unknown threat",
  11: "Early warning",
  12: "Practice drill",
  13: "Incident resolved",
};

/** Deduplicate by alertDate; return HH:MM times (first occurrence per wave). */
function dedupTimes(entries: OrefHistoryEntry[]): string[] {
  const seen = new Set<string>();
  const times: string[] = [];
  for (const e of entries) {
    if (!seen.has(e.alertDate)) {
      seen.add(e.alertDate);
      const time = e.alertDate.includes("T")
        ? (e.alertDate.split("T")[1]?.slice(0, 5) ?? e.alertDate)
        : e.alertDate;
      times.push(time);
    }
  }
  return times;
}

const QueryHistorySchema = z.object({
  zone_id: z
    .number()
    .int()
    .describe(
      "Oref area/city ID (integer). " +
        "Use 0 to aggregate ALL configured zones (user's area). " +
        "Use a specific ID from CONFIGURED_ZONES for a single area.",
    ),
  category: z
    .number()
    .int()
    .describe(
      "Alert category integer: " +
        "1=Rocket/missile siren, 2=Hostile aircraft, 3=Unconventional weapon, " +
        "4=Earthquake, 5=Radiological, 6=Infiltration, 7=Tsunami, " +
        "9=Hazmat, 10=Unknown, 11=Early warning, 12=Practice drill, " +
        "13=Incident resolved. Use 0 for all categories.",
    ),
});

/**
 * Create a deterministic history query tool backed by pre-fetched history data.
 * Returns JSON with count + HH:MM times — no LLM parsing of raw API responses.
 */
export function createQueryHistoryTool(history: OrefHistoryEntry[]) {
  return tool(
    async (input: z.infer<typeof QueryHistorySchema>) => {
      const { zone_id, category } = input;

      let filtered: OrefHistoryEntry[];
      let zoneLabel: string;

      if (zone_id === 0) {
        const configNames = resolveCityIds(config.cityIds);
        filtered = history.filter(
          (e) =>
            configNames.includes(e.data) &&
            (category === 0 || e.category === category),
        );
        zoneLabel = "all configured zones";
      } else {
        const hebrewNames = resolveCityIds([zone_id]);
        if (hebrewNames.length === 0) {
          return JSON.stringify({
            error: `Unknown zone_id: ${zone_id}. Use 0 or an ID from CONFIGURED_ZONES.`,
          });
        }
        filtered = history.filter(
          (e) =>
            e.data === hebrewNames[0] &&
            (category === 0 || e.category === category),
        );
        zoneLabel = translateAreas(hebrewNames[0]!, "en");
      }

      const times = dedupTimes(filtered);
      const catName =
        category === 0
          ? "all types"
          : (CATEGORY_EN[category] ?? `category ${category}`);

      return JSON.stringify({
        zone_id,
        zone_label: zoneLabel,
        category,
        category_name: catName,
        count: times.length,
        times,
      });
    },
    {
      name: "query_alert_history",
      description:
        "Query today's Oref alert history filtered by zone and category. " +
        "Returns exact count and HH:MM timestamps. " +
        "Use zone_id=0 for user's area (all configured zones aggregated). " +
        "Use category=1 for rocket sirens, category=13 for resolved events. " +
        "ALWAYS call this tool when asked about siren/alert counts or times.",
      schema: QueryHistorySchema,
    },
  );
}
