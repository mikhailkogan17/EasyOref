/**
 * Zod validation schemas for agent state, types, and store.
 * Replaces TypeScript interfaces with runtime validation.
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────
// Alert & Phase types
// ─────────────────────────────────────────────────────────

export const AlertTypeSchema = z.enum(["early_warning", "red_alert", "resolved"]);
export type AlertType = z.infer<typeof AlertTypeSchema>;

export const QualitativeCountSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("all") }),
  z.object({ type: z.literal("most") }),
  z.object({ type: z.literal("many") }),
  z.object({ type: z.literal("few") }),
  z.object({ type: z.literal("exists") }),
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("more_than"), value: z.number() }),
  z.object({ type: z.literal("less_than"), value: z.number() }),
]);
export type QualitativeCount = z.infer<typeof QualitativeCountSchema>;

// ─────────────────────────────────────────────────────────
// Source Message Types (input from Telegram channels)
// ─────────────────────────────────────────────────────────

export const SourceTypeSchema = z.enum([
  "telegram_channel",
  "web_scrape",
  "manual",
]);
export type SourceType = z.infer<typeof SourceTypeSchema>;

export const BaseSourceMessageSchema = z.object({
  channelId: z.string().min(1),
  sourceType: SourceTypeSchema,
  timestamp: z.number().int().min(0),
  text: z.string().min(1),
  sourceUrl: z.url().optional(),
});
export type BaseSourceMessage = z.infer<typeof BaseSourceMessageSchema>;

export const NewsMessageSchema = BaseSourceMessageSchema.extend({
  sourceType: z.literal("telegram_channel"),
  grammyMessageId: z.number().optional(),
});
export type NewsMessage = z.infer<typeof NewsMessageSchema>;

// ─────────────────────────────────────────────────────────
// Channel Types (source vs target)
// ─────────────────────────────────────────────────────────

export const NewsChannelSchema = z.object({
  channelId: z.string().min(1),
  channelName: z.string(),
  language: z.string().min(2).max(5),
  region: z.string().optional(),
});
export type NewsChannel = z.infer<typeof NewsChannelSchema>;

export const TargetGroupSchema = z.object({
  chatId: z.string().min(1),
  groupName: z.string(),
  subscribedRegions: z.array(z.string()),
});
export type TargetGroup = z.infer<typeof TargetGroupSchema>;

// ─────────────────────────────────────────────────────────
// Channel tracking (pre-graph structure)
// ─────────────────────────────────────────────────────────

export const NewsChannelWithUpdatesSchema = z.object({
  channel: z.string().min(1),
  processedMessages: z
    .array(NewsMessageSchema)
    .default([])
    .describe("Already processed messages"),
  unprocessedMessages: z
    .array(NewsMessageSchema)
    .default([])
    .describe("New messages pending processing"),
});
export type NewsChannelWithUpdates = z.infer<typeof NewsChannelWithUpdatesSchema>;

export const ChannelTrackingSchema = z.object({
  trackStartTimestamp: z.number().int().min(0),
  lastUpdateTimestamp: z.number().int().min(0),
  channelsWithUpdates: z.array(NewsChannelWithUpdatesSchema).default([]),
});
export type ChannelTracking = z.infer<typeof ChannelTrackingSchema>;

// ─────────────────────────────────────────────────────────
// Pre-filter (deterministic, zero tokens)
// ─────────────────────────────────────────────────────────

export const RelevanceCheckSchema = z.object({
  channel: z.string().min(1),
  text: z.string().min(1),
  ts: z.number().int().min(0),
  relevant: z
    .boolean()
    .describe("true if post passed keyword/region pre-filter"),
});
export type RelevanceCheck = z.infer<typeof RelevanceCheckSchema>;

// ─────────────────────────────────────────────────────────
// LLM filter (cheap pre-filter)
// ─────────────────────────────────────────────────────────

export const FilterOutputSchema = z.object({
  relevantChannels: z
    .array(z.string())
    .describe("Channels with important intel"),
});
export type FilterOutput = z.infer<typeof FilterOutputSchema>;

// ─────────────────────────────────────────────────────────
// Insight Types (discriminated union for structured extraction)
// ─────────────────────────────────────────────────────────

export const InsightKindSchema = z.enum([
  "rocket_impact",
  "rocket_interception",
  "location",
  "casualty",
  "injury",
  "eta_minutes",
  "cassette_munition",
]);
export type InsightKind = z.infer<typeof InsightKindSchema>;

export const InsightSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rocket_impact"), value: z.number().int().min(0) }),
  z.object({ kind: z.literal("rocket_interception"), value: z.number().int().min(0) }),
  z.object({ kind: z.literal("location"), value: z.string().min(1) }),
  z.object({ kind: z.literal("casualty"), value: z.number().int().min(0) }),
  z.object({ kind: z.literal("injury"), value: z.number().int().min(0) }),
  z.object({ kind: z.literal("eta_minutes"), value: z.number().int().min(0) }),
  z.object({ kind: z.literal("cassette_munition"), value: z.boolean() }),
]);
export type Insight = z.infer<typeof InsightSchema>;

// ─────────────────────────────────────────────────────────
// LLM extraction (single call per post)
// ─────────────────────────────────────────────────────────

export const ExtractionResultSchema = z.object({
  channel: z.string().min(1).describe("Source Telegram channel name"),
  regionRelevance: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "V1: region relevance (0-1) — does post mention our alert region?",
    ),
  sourceTrust: z
    .number()
    .min(0)
    .max(1)
    .describe("V2: source trust (0-1) — factual reporting vs rumors/panic?"),
  countryOrigin: z.string().optional().describe("Extracted data"),
  rocketCount: z.number().int().min(0).optional(),
  isCassette: z.boolean().optional(),
  intercepted: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Rocket breakdown: intercepted by Iron Dome"),
  interceptedQual: QualitativeCountSchema.optional().describe(
    "Qualitative descriptor when no exact number is stated (undefined if exact number given)",
  ),
  seaImpact: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Rocket breakdown: fell in sea/empty area"),
  seaImpactQual: QualitativeCountSchema.optional(),
  openAreaImpact: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Rocket breakdown: hit open/populated ground"),
  openAreaImpactQual: QualitativeCountSchema.optional(),
  hitsConfirmed: z.number().int().min(0).optional(),
  hitLocation: z
    .string()
    .optional()
    .describe("Region where impact occurred (in UI language)"),
  hitType: z.enum(["direct", "shrapnel"]).optional().describe("Type of impact"),
  hitDetail: z
    .string()
    .optional()
    .describe(
      'Impact detail: where/how (e.g. "open area", "building", "sea", "no damage"). In UI language.',
    ),
  casualties: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Casualties reported (injured/killed) — primarily resolved phase",
    ),
  injuries: z.number().int().min(0).optional(),
  injuriesCause: z
    .enum(["rocket", "rushing_to_shelter"])
    .optional()
    .describe(
      "Cause of injuries: rocket fragment/direct hit vs panic/rushing to shelter",
    ),
  etaRefinedMinutes: z.number().int().min(0).optional(),
  rocketDetail: z
    .string()
    .optional()
    .describe(
      'Verbatim per-region rocket breakdown (e.g. "2 center, 3 north")',
    ),
  tone: z
    .enum(["calm", "neutral", "alarmist"])
    .describe('V3: tone — "calm"|"neutral"|"alarmist"'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Overall extraction confidence (0-1)"),
  timeRelevance: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "Time relevance (0-1) — does this post discuss the CURRENT attack? LLM sets: 0 = clearly about a previous/different event, 1 = current event. Post-filter rejects posts with timeRelevance < 0.5.",
    ),
});
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

// ─────────────────────────────────────────────────────────
// Post-filter (deterministic, zero tokens)
// ─────────────────────────────────────────────────────────

export const ValidatedExtractionSchema = ExtractionResultSchema.extend({
  valid: z.boolean().describe("Passed all three validators?"),
  rejectReason: z.string().optional().describe("Reason if rejected"),
  messageUrl: z
    .url()
    .optional()
    .describe("Link to original Telegram post (from ChannelPost.messageUrl)"),
});
export type ValidatedExtraction = z.infer<typeof ValidatedExtractionSchema>;

// ─────────────────────────────────────────────────────────
// Cited sources & voting
// ─────────────────────────────────────────────────────────

export const CitedSourceSchema = z.object({
  index: z.number().int().min(1).describe("1-based citation index"),
  channel: z.string().min(1),
  messageUrl: z.url().optional(),
});
export type CitedSource = z.infer<typeof CitedSourceSchema>;

export const CountryOriginSchema = z.object({
  name: z.string().min(1),
  citations: z.array(z.number().int().min(1)),
});

export const VotedResultSchema = z.object({
  etaRefinedMinutes: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("ETA in minutes (highest-confidence source)"),
  etaCitations: z
    .array(z.number().int().min(1))
    .default([])
    .describe("Citation indices that provided ETA"),

  countryOrigins: z
    .array(CountryOriginSchema)
    .default([])
    .describe("Unique origin countries with per-country citation indices"),

  rocketCountMin: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Rocket count range across sources (min == max → exact)"),
  rocketCountMax: z.number().int().min(0).optional(),
  rocketCitations: z.array(z.number().int().min(1)).default([]),
  rocketConfidence: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe(
      "Avg weighted confidence of sources reporting rocket count (for uncertainty marker)",
    ),
  rocketDetail: z
    .string()
    .optional()
    .describe(
      "Verbatim per-region rocket breakdown if sources split by region",
    ),

  isCassette: z.boolean().optional(),
  isCassetteConfidence: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe(
      "Avg weighted confidence of sources confirming cassette munitions",
    ),

  intercepted: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Rocket breakdown (median values; undefined if no sources reported)",
    ),
  interceptedQual: QualitativeCountSchema.optional(),
  interceptedConfidence: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe("Avg weighted confidence of sources reporting intercepted count"),
  seaImpact: z.number().int().min(0).optional(),
  seaImpactQual: QualitativeCountSchema.optional(),
  seaConfidence: z.number().min(0).max(1).default(0),
  openAreaImpact: z.number().int().min(0).optional(),
  openAreaImpactQual: QualitativeCountSchema.optional(),
  openAreaConfidence: z.number().min(0).max(1).default(0),

  hitsConfirmed: z.number().int().min(0).optional(),
  hitsCitations: z
    .array(z.number().int().min(1))
    .default([])
    .describe("Citation indices that provided hits data"),
  hitsConfidence: z
    .number()
    .min(0)
    .max(1)
    .default(0)
    .describe("Avg weighted confidence of sources reporting confirmed hits"),
  hitLocation: z
    .string()
    .optional()
    .describe(
      "Region where impact occurred (in UI language, from highest-confidence source)",
    ),
  hitType: z
    .enum(["direct", "shrapnel"])
    .optional()
    .describe("Type of impact: direct or shrapnel/debris"),
  hitDetail: z
    .string()
    .optional()
    .describe(
      'Impact detail: where/how (e.g. "на открытой местности", "здание", "в море")',
    ),
  noImpacts: z
    .boolean()
    .default(false)
    .describe('Sources explicitly confirm NO impacts ("прилетов нет")'),
  noImpactsCitations: z.array(z.number().int().min(1)).default([]),
  interceptedCitations: z
    .array(z.number().int().min(1))
    .default([])
    .describe("Citation indices for intercepted data"),

  casualties: z.number().int().min(0).optional(),
  casualtiesCitations: z.array(z.number().int().min(1)).default([]),
  casualtiesConfidence: z.number().min(0).max(1).default(0),

  injuries: z.number().int().min(0).optional(),
  injuriesCause: z.enum(["rocket", "rushing_to_shelter"]).optional(),
  injuriesCitations: z.array(z.number().int().min(1)).default([]),
  injuriesConfidence: z.number().min(0).max(1).default(0),

  confidence: z.number().min(0).max(1).default(0),
  sourcesCount: z.number().int().min(0).default(0),
  citedSources: z
    .array(CitedSourceSchema)
    .default([])
    .describe("All valid sources, ordered by citation index"),
});
export type VotedResult = z.infer<typeof VotedResultSchema>;

// ─────────────────────────────────────────────────────────
// Simplified Vote Result (using Insight discriminatedUnion)
// ─────────────────────────────────────────────────────────

export const ConsensusInsightSchema = z.object({
  insight: InsightSchema,
  validExtractions: z.array(z.lazy(() => ValidatedExtractionSchema)).default([]),
  avgConfidence: z.number().min(0).max(1),
  sourcesCount: z.number().int().min(1),
});
export type ConsensusInsight = z.infer<typeof ConsensusInsightSchema>;

export const VoteResultSchemaV2 = z.object({
  insights: z.array(ConsensusInsightSchema).default([]),
  needsClarify: z.array(z.lazy(() => ExtractionResultSchema)).default([]),
  timestamp: z.number().int().min(0),
});
export type VoteResultV2 = z.infer<typeof VoteResultSchemaV2>;

// Alias for backward compatibility
export const VoteResultSchema = VotedResultSchema;
export type VoteResult = VotedResult;

// ─────────────────────────────────────────────────────────
// Enrichment data (cross-phase persistence)
// ─────────────────────────────────────────────────────────

export const InlineCiteSchema = z.object({
  url: z.url(),
  channel: z.string().min(1),
});
export type InlineCite = z.infer<typeof InlineCiteSchema>;

export const EnrichmentDataSchema = z.object({
  origin: z
    .string()
    .optional()
    .describe("Origin country (from early_warning or siren)"),
  originCites: z.array(InlineCiteSchema).default([]),
  etaAbsolute: z
    .string()
    .optional()
    .describe('ETA absolute time string (e.g. "~17:42")'),
  etaCites: z.array(InlineCiteSchema).default([]),
  rocketCount: z
    .string()
    .optional()
    .describe('Rocket count display string (e.g. "~5–7")'),
  rocketCites: z.array(InlineCiteSchema).default([]),
  isCassette: z.boolean().optional().describe("Is cassette munitions"),
  intercepted: z
    .string()
    .optional()
    .describe('Interception data display string (e.g. "3", "большинство")'),
  interceptedCites: z.array(InlineCiteSchema).default([]),
  seaImpact: z.string().optional().describe("Sea impact display string"),
  openAreaImpact: z
    .string()
    .optional()
    .describe("Open area impact display string"),
  hitsConfirmed: z.string().optional().describe("Confirmed hits on structures"),
  hitsCites: z.array(InlineCiteSchema).default([]),
  hitLocation: z
    .string()
    .optional()
    .describe("Region where impact occurred (in UI language)"),
  hitType: z
    .string()
    .optional()
    .describe('Type of impact: "direct" | "shrapnel"'),
  hitDetail: z
    .string()
    .optional()
    .describe(
      'Impact detail: where/how (e.g. "на открытой местности", "здание")',
    ),
  noImpacts: z
    .boolean()
    .default(false)
    .describe('Sources explicitly confirm NO impacts ("прилетов нет")'),
  noImpactsCites: z.array(InlineCiteSchema).default([]),
  rocketDetail: z
    .string()
    .optional()
    .describe("Verbatim per-region rocket breakdown"),
  casualties: z
    .string()
    .optional()
    .describe("Casualties / injuries (from resolved)"),
  casualtiesCites: z.array(InlineCiteSchema).default([]),
  injuries: z.string().optional(),
  injuriesCause: z
    .enum(["rocket", "rushing_to_shelter"])
    .optional()
    .describe(
      "Cause display string — set only if injuries came from rushing to shelter",
    ),
  injuriesCites: z.array(InlineCiteSchema).default([]),
  earlyWarningTime: z
    .string()
    .optional()
    .describe(
      'Time early_warning was received (for siren "Раннее: было в HH:MM")',
    ),
  lastEditHash: z
    .string()
    .optional()
    .describe(
      'Hash of last enriched text to detect "message not modified" before sending',
    ),
});
export type EnrichmentData = z.infer<typeof EnrichmentDataSchema>;

// ─────────────────────────────────────────────────────────
// Chat & Alert metadata (store)
// ─────────────────────────────────────────────────────────

export const TelegramMessageSchema = z.object({
  chatId: z.string().min(1),
  messageId: z.number().int().min(1),
  isCaption: z.boolean(),
});
export type TelegramMessage = z.infer<typeof TelegramMessageSchema>;

export const AlertMetaSchema = z.object({
  alertId: z.string().min(1),
  messageId: z.number().int().min(1),
  chatId: z.string().min(1),
  isCaption: z.boolean(),
  alertTs: z.number().int().min(0),
  alertType: AlertTypeSchema,
  alertAreas: z.array(z.string().min(1)),
  currentText: z.string().min(1),
});
export type AlertMeta = z.infer<typeof AlertMetaSchema>;

export const ChannelPostSchema = z.object({
  channel: z.string().min(1),
  text: z.string().min(1),
  ts: z.number().int().min(0),
  messageUrl: z.url().optional(),
});
export type ChannelPost = z.infer<typeof ChannelPostSchema>;

export const ActiveSessionSchema = z.object({
  sessionId: z.string().min(1),
  sessionStartTs: z.number().int().min(0),
  phase: AlertTypeSchema,
  phaseStartTs: z.number().int().min(0),
  latestAlertId: z.string().min(1),
  latestMessageId: z.number().int().min(1),
  latestAlertTs: z.number().int().min(0),
  chatId: z.string().min(1),
  isCaption: z.boolean(),
  currentText: z.string().min(1),
  baseText: z.string().min(1),
  alertAreas: z.array(z.string().min(1)),
  telegramMessages: z.array(TelegramMessageSchema).optional(),
});
export type ActiveSession = z.infer<typeof ActiveSessionSchema>;

// ─────────────────────────────────────────────────────────
// Extract & Clarify contexts
// ─────────────────────────────────────────────────────────

export const ExtractContextSchema = z.object({
  alertTs: z.number().int().min(0),
  alertType: AlertTypeSchema,
  alertAreas: z.array(z.string().min(1)),
  alertId: z.string().min(1),
  language: z.string().min(1),
  existingEnrichment: EnrichmentDataSchema.optional(),
});
export type ExtractContext = z.infer<typeof ExtractContextSchema>;

export const ClarifyInputSchema = z.object({
  alertId: z.string().min(1),
  alertAreas: z.array(z.string().min(1)),
  alertType: z.string().min(1),
  alertTs: z.number().int().min(0),
  messageId: z.number().int().min(1),
  currentText: z.string().min(1),
  extractions: z.array(ValidatedExtractionSchema),
  votedResult: VotedResultSchema,
});
export type ClarifyInput = z.infer<typeof ClarifyInputSchema>;

export const ClarifyOutputSchema = z.object({
  newPosts: z.array(ChannelPostSchema),
  newExtractions: z.array(ValidatedExtractionSchema),
  toolCallCount: z.number().int().min(0),
  clarified: z.boolean(),
});
export type ClarifyOutput = z.infer<typeof ClarifyOutputSchema>;

// ─────────────────────────────────────────────────────────
// Graph & enrichment input
// ─────────────────────────────────────────────────────────

export const RunEnrichmentInputSchema = z.object({
  alertId: z.string().min(1),
  alertTs: z.number().int().min(0),
  alertType: AlertTypeSchema,
  alertAreas: z.array(z.string().min(1)),
  chatId: z.string().min(1),
  messageId: z.number().int().min(1),
  isCaption: z.boolean(),
  currentText: z.string().min(1),
  telegramMessages: z.array(TelegramMessageSchema).default([]),
  monitoringLabel: z.string().optional(),
});
export type RunEnrichmentInput = z.infer<typeof RunEnrichmentInputSchema>;

// ─────────────────────────────────────────────────────────
// Config types
// ─────────────────────────────────────────────────────────

export type AlertTypeConfig = "early" | "red_alert" | "resolved";

export const GifModeSchema = z.enum(["funny_cats", "none"]);
export type GifMode = z.infer<typeof GifModeSchema>;

// ─────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────

/** Create empty enrichment data */
export function createEmptyEnrichmentData(): EnrichmentData {
  return EnrichmentDataSchema.parse({
    originCites: [],
    etaCites: [],
    rocketCites: [],
    interceptedCites: [],
    hitsCites: [],
    noImpacts: false,
    noImpactsCites: [],
    casualtiesCites: [],
    injuriesCites: [],
  });
}

export const emptyEnrichmentData = createEmptyEnrichmentData();

/** Validate and parse JSON string */
export function parseJSON<T extends z.ZodSchema>(
  schema: T,
  json: string,
): z.infer<T> {
  const parsed = JSON.parse(json);
  return schema.parse(parsed);
}

/** Safely validate data, returning error string instead of throwing */
export function validateSafe<T extends z.ZodSchema>(
  schema: T,
  data: unknown,
): { ok: true; data: z.infer<T> } | { ok: false; error: string } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  return { ok: false, error: result.error.message };
}
