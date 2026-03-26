/**
 * Zone Priority Logic - Zod schemas and utilities
 *
 * Responsibilities:
 * - Define geo hierarchy: zone < city < area < macro < country
 * - Prioritize zone-specific data over broader area data
 * - Format output based on current alert zone
 */

import { z } from "zod";

export const GeoLevel = z.enum(["zone", "city", "area", "macro", "country"]);
export type GeoLevel = z.infer<typeof GeoLevel>;

export const GeoMetadata = z.object({
  level: GeoLevel,
  city: z.string().optional().describe("e.g. 'תל אביב'"),
  area: z.string().optional().describe("e.g. 'גוש דן'"),
  macro: z.string().optional().describe("e.g. 'מרכז', 'דרום', 'צפון'"),
});
export type GeoMetadata = z.infer<typeof GeoMetadata>;

export const ZoneMatch = z.object({
  name: z.string().describe("Full zone name from alert"),
  metadata: GeoMetadata,
  covers: z.array(z.string()).optional().describe("Sub-zones this covers"),
});
export type ZoneMatch = z.infer<typeof ZoneMatch>;

export const ZonePriorityInput = z.object({
  enrichment: z
    .record(z.string(), z.string())
    .describe("Enrichment as Record<string, string>"),
  currentAlertAreas: z.array(z.string()),
});
export type ZonePriorityInput = z.infer<typeof ZonePriorityInput>;

export const ZonePriorityOutput = z.object({
  enrichment: z.record(z.string(), z.string()),
  zoneContext: z.string(),
  warnings: z.array(z.string()).default([]),
});
export type ZonePriorityOutput = z.infer<typeof ZonePriorityOutput>;

export const ZONE_HIERARCHY: Record<string, GeoMetadata> = {
  // Тель-Авив зоны
  "תל אביב - מרכז העיר": {
    level: "zone",
    city: "תל אביב",
    area: "גוש דן",
    macro: "מרכז",
  },
  "תל אביב - דרום העיר ויפו": {
    level: "zone",
    city: "תל אביב",
    area: "גוש דן",
    macro: "מרכז",
  },
  "תל אביב - מזרח": {
    level: "zone",
    city: "תל אביב",
    area: "גוש דן",
    macro: "מרכז",
  },
  "תל אביב - עבר הירקון": {
    level: "zone",
    city: "תל אביב",
    area: "גוש דן",
    macro: "מרכז",
  },

  // Гуш Дан
  גוש_דן: { level: "area", macro: "מרכז" },

  // Макрорегионы
  מרכז: { level: "macro" },
  דרום: { level: "macro" },
  צפון: { level: "macro" },
} as const;

export function getZoneMetadata(areaName: string): GeoMetadata | undefined {
  return ZONE_HIERARCHY[areaName as keyof typeof ZONE_HIERARCHY];
}

export function prioritizeZoneData(
  input: ZonePriorityInput,
): ZonePriorityOutput {
  // TODO: Implement zone priority logic
  return {
    enrichment: input.enrichment,
    zoneContext: "",
    warnings: [],
  };
}
