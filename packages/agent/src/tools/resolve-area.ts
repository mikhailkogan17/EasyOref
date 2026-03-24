/**
 * Resolve area relevance tool — check if location is in user's defense zone.
 */

import * as logger from "@easyoref/monitoring";
import { config } from "@easyoref/shared";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const AREA_PROXIMITY_GROUPS: Record<string, string[]> = {
  "גוש דן": [
    "תל אביב", "רמת גן", "גבעתיים", "בני ברק", "חולון", "בת ים",
    "פתח תקווה", "גבעת שמואל", "אור יהודה", "יהוד", "קריית אונו",
  ],
  שרון: ["הרצליה", "רעננה", "כפר סבא", "הוד השרון", "נתניה", "רמת השרון", "כוכב יאיר"],
  מרכז: ["ראשון לציון", "רחובות", "נס ציונה", "לוד", "רמלה", "מודיעין", "יבנה", "שוהם"],
  ירושלים: ["ירושלים", "בית שמש", "מעלה אדומים", "מבשרת ציון"],
  חיפה: ["חיפה", "קריות", "קריית אתא", "קריית ביאליק", "קריית מוצקין", "טירת כרמל", "נשר"],
  "דרום-מערב": ["אשקלון", "אשדוד", "גן יבנה", "קריית מלאכי"],
  "עוטף עזה": ["שדרות", "עוטף עזה", "נתיבות", "אופקים"],
  "באר שבע": ["באר שבע", "ערד", "דימונה"],
  "גליל עליון": ["קריית שמונה", "מטולה", "צפת", "ראש פינה"],
};

function resolveAreaProximity(
  mentioned: string,
  monitoredAreas: string[],
): {
  relevant: boolean;
  sameZone: string | undefined;
  monitoredMatch: string[];
  reasoning: string;
} {
  const normalizedMentioned = mentioned.toLowerCase().trim();
  const normalizedMentionedHebrew = mentioned.replace(/\s+/g, "");

  for (const area of monitoredAreas) {
    const normalizedArea = area.toLowerCase().trim();
    const normalizedAreaHebrew = area.replace(/\s+/g, "");

    if (
      normalizedMentioned === normalizedArea ||
      normalizedMentioned.includes(normalizedArea) ||
      normalizedArea.includes(normalizedMentioned) ||
      normalizedMentionedHebrew === normalizedAreaHebrew ||
      normalizedMentionedHebrew.includes(normalizedAreaHebrew)
    ) {
      return {
        relevant: true,
        sameZone: undefined,
        monitoredMatch: [area],
        reasoning: `"${mentioned}" directly matches monitored area "${area}"`,
      };
    }
  }

  for (const [zone, cities] of Object.entries(AREA_PROXIMITY_GROUPS)) {
    const mentionedNormalized = mentioned.toLowerCase();
    const mentionedHebrew = mentioned.replace(/\s+/g, "");

    for (const city of cities) {
      const cityNormalized = city.toLowerCase();
      const cityHebrew = city.replace(/\s+/g, "");

      if (
        mentionedNormalized === cityNormalized ||
        mentionedNormalized.includes(cityNormalized) ||
        cityNormalized.includes(mentionedNormalized) ||
        mentionedHebrew === cityHebrew ||
        mentionedHebrew.includes(cityHebrew)
      ) {
        const matchedMonitored = monitoredAreas.filter((mArea) => {
          const mAreaNormalized = mArea.toLowerCase().replace(/\s+/g, "");
          return cities.some(
            (c) =>
              c.toLowerCase().replace(/\s+/g, "") === mAreaNormalized ||
              mAreaNormalized.includes(c.toLowerCase().replace(/\s+/g, "")) ||
              c.toLowerCase().replace(/\s+/g, "").includes(mAreaNormalized),
          );
        });

        if (matchedMonitored.length > 0) {
          return {
            relevant: true,
            sameZone: zone,
            monitoredMatch: matchedMonitored,
            reasoning:
              `"${mentioned}" is in zone "${zone}" together with monitored: ` +
              matchedMonitored.join(", "),
          };
        }

        return {
          relevant: false,
          sameZone: zone,
          monitoredMatch: [],
          reasoning:
            `"${mentioned}" is in zone "${zone}" but none of user's monitored ` +
            `areas (${monitoredAreas.join(", ")}) are in that zone`,
        };
      }
    }
  }

  return {
    relevant: false,
    sameZone: undefined,
    monitoredMatch: [],
    reasoning:
      `"${mentioned}" could not be matched to any monitored area ` +
      `(${monitoredAreas.join(", ")})`,
  };
}

const REGION_KEYWORDS: Record<string, string[]> = {
  מרכז: ["תל אביב", "רמת גן", "פתח תקווה", "ראשון לציון", "הרצליה", "חולון"],
  צפון: ["חיפה", "קריות", "צפת", "קריית שמונה", "נצרת", "עכו", "טבריה"],
  דרום: ["באר שבע", "אשדוד", "אשקלון", "שדרות", "אילת"],
};

function resolveAreaProximityWithRegions(
  mentioned: string,
  monitoredAreas: string[],
): {
  relevant: boolean;
  sameZone: string | undefined;
  monitoredMatch: string[];
  reasoning: string;
} {
  const baseResult = resolveAreaProximity(mentioned, monitoredAreas);
  if (baseResult.relevant) {
    return baseResult;
  }

  const mentionedLower = mentioned.toLowerCase();

  for (const [region, cities] of Object.entries(REGION_KEYWORDS)) {
    if (!mentionedLower.includes(region)) continue;
    const matchedMonitored = monitoredAreas.filter((m) =>
      cities.some((c) => m.includes(c) || c.includes(m.split(" ")[0] ?? "")),
    );
    if (matchedMonitored.length > 0) {
      return {
        relevant: true,
        sameZone: region,
        monitoredMatch: matchedMonitored,
        reasoning:
          `"${mentioned}" refers to region "${region}" which includes ` +
          matchedMonitored.join(", "),
      };
    }
  }

  return baseResult;
}

export { resolveAreaProximityWithRegions as resolveAreaProximity };

export const resolveAreaTool = tool(
  async ({ location }: { location: string }): Promise<string> => {
    const monitoredAreas = config.areas;

    if (monitoredAreas.length === 0) {
      return JSON.stringify({
        error: "No monitored areas configured",
        hint: "User has not set up city monitoring",
      });
    }

    const result = resolveAreaProximityWithRegions(location, monitoredAreas);

    logger.info("Tool: resolve_area executed", {
      location,
      relevant: result.relevant,
      zone: result.sameZone,
    });

    return JSON.stringify({
      location,
      monitored_areas: monitoredAreas,
      ...result,
    });
  },
  {
    name: "resolve_area",
    description:
      "Determine if a location mentioned in news is relevant to the user's " +
      "monitored areas. Uses defense-zone proximity: cities in the same Iron Dome " +
      "coverage zone are considered relevant. " +
      'Example: "попадание в Петах Тикве" → relevant for Herzliya user ' +
      "(both in Gush Dan / Sharon zone). " +
      'Use when a news post mentions a city or region like "center" and you need ' +
      "to determine if it affects the user.",
    schema: z.object({
      location: z
        .string()
        .describe(
          "City or region name in Hebrew as mentioned in news (e.g. פתח תקווה, מרכז)",
        ),
    }),
  },
);
