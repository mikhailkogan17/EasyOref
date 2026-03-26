/**
 * Output Formatter - Zod schemas and utilities
 *
 * Responsibilities:
 * - Format enrichment text for Telegram
 * - Validate source URLs
 * - Handle sensitive topics (casualties, rocket 0)
 * - Zone-aware output formatting
 */

import { z } from "zod";
import type { AlertType } from "./schemas.js";

export const SourceValidation = z.object({
  valid: z.boolean(),
  badUrls: z.array(z.string()).default([]),
  missingUrls: z.array(z.string()).default([]),
});
export type SourceValidation = z.infer<typeof SourceValidation>;

export const FormatWarnings = z.object({
  lowConfidence: z.array(z.string()).default([]),
  missingSources: z.array(z.string()).default([]),
  zoneMismatch: z.array(z.string()).default([]),
});
export type FormatWarnings = z.infer<typeof FormatWarnings>;

export const OutputFormatInput = z.object({
  enrichment: z
    .record(z.string(), z.string())
    .describe("Enrichment as Record<string, string>"),
  votedResult: z.object({
    insights: z.array(z.any()).describe("Array of ValidatedInsight"),
    needsClarify: z.boolean().default(false),
    timestamp: z.number().int().min(0),
  }),
  alertType: z.enum(["early_warning", "red_alert", "resolved"]),
  alertAreas: z.array(z.string()),
});
export type OutputFormatInput = z.infer<typeof OutputFormatInput>;

export const OutputFormatOutput = z.object({
  text: z.string(),
  warnings: FormatWarnings,
});
export type OutputFormatOutput = z.infer<typeof OutputFormatOutput>;

const TELEGRAM_URL_PATTERN = /^https?:\/\/(t\.me|telegram\.me)\//;

export function validateSources(votedResult: {
  insights: unknown[];
  needsClarify: boolean;
  timestamp: number;
}): SourceValidation {
  // TODO: Implement source validation
  return {
    valid: true,
    badUrls: [],
    missingUrls: [],
  };
}

export function formatForCurrentZone(
  text: string,
  alertAreas: string[],
  enrichment: Record<string, string>,
): string {
  // TODO: Implement zone-aware formatting
  return text;
}

export function formatEnrichmentText(
  input: OutputFormatInput,
): OutputFormatOutput {
  // TODO: Implement enrichment text formatting
  return {
    text: "",
    warnings: {
      lowConfidence: [],
      missingSources: [],
      zoneMismatch: [],
    },
  };
}

export function shouldHideCasualties(
  confidence: number,
  alertType: AlertType,
): boolean {
  // TODO: Implement casualty hiding logic
  return confidence < 0.85;
}

export function shouldShowRocketZero(
  rocketCount: number | undefined,
  confidence: number,
  alertType: AlertType,
): boolean {
  // TODO: Implement rocket zero visibility logic
  return rocketCount === 0 && confidence >= 0.8;
}
