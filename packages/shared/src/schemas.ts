/**
 * Zod validation schemas for agent state, types, and store.
 * Replaces TypeScript interfaces with runtime validation.
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────
// Alert & Phase types
// ─────────────────────────────────────────────────────────

/**
 * Location relevance of an insight relative to the user's monitored zone.
 *
 * - exact_user_zone   — the news explicitly names the user's specific zone (e.g. "תל אביב מרכז")
 * - user_macro_region — the news names a broader region that contains the user's zone (e.g. "מרכז")
 *                     → show with remark: "Центр: N попаданий (Тель-Авив — нет данных)"
 * - not_a_user_zone    — the news names a region with zero overlap with user zones (e.g. Petah Tikva)
 *                     → vote-node drops the insight entirely
 * - undefined       — not a location insight (eta, country_origins, rocket_count, etc.)
 */
export const InsightLocation = z.union([
  z
    .literal("exact_user_zone")
    .describe(
      "EXACT user locality or district. May be bigger than Iron Dome zone",
    ),
  z
    .literal("user_macro_region")
    .describe(
      "Region or area that CONTAINS user zone. E.g. Dan or Center for Tel Aviv",
    ),
  z
    .literal("not_a_user_zone")
    .describe(
      "Total mismatch with user location. E.g. Petach Tikva for Bat Yam or B7 for Haifa",
    ),
]);
export type InsightLocationType = z.infer<typeof InsightLocation>;

export const AlertType = z.enum(["early_warning", "red_alert", "resolved"]);
export type AlertType = z.infer<typeof AlertType>;

export const QualitativeCount = z.discriminatedUnion("type", [
  z.object({ type: z.literal("all") }),
  z.object({ type: z.literal("most") }),
  z.object({ type: z.literal("many") }),
  z.object({ type: z.literal("few") }),
  z.object({ type: z.literal("exists") }),
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("more_than"), value: z.number() }),
  z.object({ type: z.literal("less_than"), value: z.number() }),
  z.object({ type: z.literal("exact"), value: z.number() }),
]);
export type QualitativeCountType = z.infer<typeof QualitativeCount>;

// ─────────────────────────────────────────────────────────
// Source Message Types (input from Telegram channels)
// ─────────────────────────────────────────────────────────

export const SourceKind = z.enum(["telegram_channel", "web_scrape", "manual"]);
export type SourceKindType = z.infer<typeof SourceKind>;

export const BaseSourceMessage = z.object({
  channelId: z.string().min(1),
  sourceType: SourceKind,
  timestamp: z.number().int().min(0),
  text: z.string().min(1),
  sourceUrl: z.url().optional(),
});
export type BaseSourceMessageType = z.infer<typeof BaseSourceMessage>;

export const NewsMessage = BaseSourceMessage.extend({
  sourceType: z.literal("telegram_channel"),
  grammyMessageId: z.number().optional(),
});
export type NewsMessageType = z.infer<typeof NewsMessage>;

// ─────────────────────────────────────────────────────────
// Channel Types (source vs target)
// ─────────────────────────────────────────────────────────

export const NewsChannel = z.object({
  channelId: z.string().min(1),
  channelName: z.string(),
  language: z.string().min(2).max(5),
  region: z.string().optional(),
});
export type NewsChannelType = z.infer<typeof NewsChannel>;

export const TargetGroup = z.object({
  chatId: z.string().min(1),
  groupName: z.string(),
  subscribedRegions: z.array(z.string()),
});
export type TargetGroupType = z.infer<typeof TargetGroup>;

// ─────────────────────────────────────────────────────────
// Channel tracking (pre-graph structure)
// ─────────────────────────────────────────────────────────

export const NewsChannelWithUpdates = z.object({
  channel: z.string().min(1),
  processedMessages: z
    .array(NewsMessage)
    .describe("Already processed messages"),
  unprocessedMessages: z
    .array(NewsMessage)
    .describe("New messages pending processing"),
});
export type NewsChannelWithUpdatesType = z.infer<typeof NewsChannelWithUpdates>;

export const ChannelTracking = z.object({
  trackStartTimestamp: z.number().int().min(0),
  lastUpdateTimestamp: z.number().int().min(0),
  channelsWithUpdates: z.array(NewsChannelWithUpdates),
});
export type ChannelTrackingType = z.infer<typeof ChannelTracking>;

// ─────────────────────────────────────────────────────────
// Pre-filter
// ─────────────────────────────────────────────────────────

export const RelevanceCheck = z.object({
  channel: z.string().min(1),
  text: z.string().min(1),
  ts: z.number().int().min(0),
  relevant: z
    .boolean()
    .describe("true if post passed keyword/region pre-filter"),
});
export type RelevanceCheckType = z.infer<typeof RelevanceCheck>;

// ─────────────────────────────────────────────────────────
// LLM filter
// ─────────────────────────────────────────────────────────

export const FilterOutput = z.object({
  relevantChannels: z
    .array(z.string())
    .describe("Channels with important intel"),
});
export type FilterOutputType = z.infer<typeof FilterOutput>;

// ─────────────────────────────────────────────────────────
// Insight
// ─────────────────────────────────────────────────────────

export const ETAShhema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("minutes"),
    minutes: z.number().int().optional().describe("ETA in minutes"),
  }),
  z.object({
    kind: z.literal("exact_time"),
    exactTime: z.iso.time().optional().describe("ETA in minutes"),
  }),
]);

export const Hit = z.object({
  type: z.enum(["direct", "shrapnel"]),
  count: z.number().min(1),
  cities: z.array(z.string()).describe("e.g. Holon"),
  aglomeration: z.array(z.string()).describe("e.g. Gush Dan or Sharon"),
  macroregion: z.enum(["center", "north"]),
});

export const RocketImpact = z.object({
  interceptionsCount: QualitativeCount.optional().describe(
    "rockets intercepted",
  ),
  seaFallsCount: QualitativeCount.optional().describe(
    "rockets fell into sea count",
  ),
  openAreaFallsCount: QualitativeCount.optional().describe(
    "rockets fell into open area count",
  ),
  hits: z.array(Hit).optional(),
});

export const Casuality = z.object({
  count: z.number(),
  level: z.enum(["easy", "medium", "hard", "death"]).optional(),
  cause: z.enum(["rocket", "rushing_to_shelter"]),
});

export const InsightKind = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("eta"),
    value: ETAShhema,
  }),
  z.object({
    kind: z.literal("country_origins"),
    value: z
      .array(z.string())
      .min(1)
      .describe("Unique origin countries with per-country citation indices"),
  }),
  z.object({
    kind: z.literal("rocket_count"),
    value: QualitativeCount.describe(
      "Rocket count (Qualitative: exact (if at least 1), more_than and less_than)",
    ),
  }),
  z.object({
    kind: z.literal("cluser_munition_used"),
    value: z.boolean().describe("true if rocket has a cluster munition"),
  }),
  z.object({
    kind: z.literal("impact"),
    value: RocketImpact,
  }),
  z.object({
    kind: z.literal("casualities"),
    value: z.array(Casuality),
  }),
]);

export const Insight = z.object({
  kind: InsightKind,
  timeRelevance: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "How relevant this insight is to CURRENT alert (0=stale, 1=current)",
    ),
  regionRelevance: z
    .number()
    .min(0)
    .max(1)
    .describe("How relevant this insight to alert region"),
  confidence: z.number().min(0).max(1).describe("Extraction confidence"),
  source: BaseSourceMessage,
  timeStamp: z.string().describe("ISO 8601 timestamp"),
  extractionReason: z.string().optional(),
});
export type InsightType = z.infer<typeof Insight>;

export const ValidatedInsight = Insight.extend({
  confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Extraction confidence (0-1)"),
  sourceTrust: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Source trust score (0-1)"),
  isValid: z.boolean(),
  rejectionReason: z.string().optional(),
  /**
   * Location relevance of this insight.
   * undefined = not a location insight (eta, country_origins, rocket_count, etc.)
   */
  insightLocation: InsightLocation.optional(),
});
export type ValidatedInsightType = z.infer<typeof ValidatedInsight>;

// ─────────────────────────────────────────────────────────
// Confidence Matrix — insight verification thresholds
// ─────────────────────────────────────────────────────────

export type ClarifyNeed = "needs_clarify" | "uncertain" | "verified";

export interface InsightConfidenceThresholds {
  needsClarify: number;
  uncertain: number;
  verified: number;
}

export const CONFIDENCE_MATRIX: Record<string, InsightConfidenceThresholds> = {
  eta: { needsClarify: 0.4, uncertain: 0.5, verified: 0.55 },
  country_origins: { needsClarify: 0.4, uncertain: 0.6, verified: 0.75 },
  rocket_count: { needsClarify: 0.4, uncertain: 0.5, verified: 0.6 },
  cluser_munition_used: { needsClarify: 0.4, uncertain: 0.5, verified: 0.7 },
  impact: { needsClarify: 0.4, uncertain: 0.5, verified: 0.6 },
  casualities: { needsClarify: 0.85, uncertain: 0.9, verified: 0.95 },
};

export function getClarifyNeed(
  insightKindLiteral: string,
  confidence: number,
): ClarifyNeed {
  const thresholds = CONFIDENCE_MATRIX[insightKindLiteral];
  if (!thresholds) return "uncertain";
  if (confidence < thresholds.needsClarify) return "needs_clarify";
  if (confidence < thresholds.uncertain) return "uncertain";
  return "verified";
}

// ─────────────────────────────────────────────────────────
// Enrichment data (cross-phase persistence) — simplified to Record<string, string>
// ─────────────────────────────────────────────────────────

export const Enrichment = z
  .record(z.string(), z.string())
  .describe(
    "Key-value enrichment data: origin, eta, rocket_count, hit_location, etc.",
  );
export type EnrichmentType = z.infer<typeof Enrichment>;

export function createEmptyEnrichment(): EnrichmentType {
  return {};
}

export const emptyEnrichment = createEmptyEnrichment();

// ─────────────────────────────────────────────────────────
// Voting
// ─────────────────────────────────────────────────────────

/**
 * VotedInsight — consensus result for a single insight kind.
 * New structure (not extends ValidatedInsight) with sources: BaseSourceMessage[].
 */
export const VotedInsight = z.object({
  kind: InsightKind,
  sources: z
    .array(BaseSourceMessage)
    .min(1)
    .describe("All source messages that contributed to this consensus insight"),
  confidence: z.number().min(0).max(1).describe("Weighted average confidence"),
  sourceTrust: z
    .number()
    .min(0)
    .max(1)
    .describe("Weighted average source trust"),
  timeRelevance: z.number().min(0).max(1),
  regionRelevance: z.number().min(0).max(1),
  /** Inherited from constituent insights. undefined = not a location insight. */
  insightLocation: InsightLocation.optional(),
  reason: z.string().optional().describe("Why this consensus was chosen"),
  rejectedInsights: z
    .array(ValidatedInsight)
    .describe("Rejected alternatives for this kind"),
});
export type VotedInsightType = z.infer<typeof VotedInsight>;

export const VotedResult = z.object({
  insights: z
    .array(ValidatedInsight)
    .describe("All valid insights (new + carried-forward) used in voting"),
  consensus: z
    .record(z.string(), VotedInsight)
    .describe("One consensus insight per kind (key = kind literal)"),
  needsClarify: z
    .boolean()
    .describe("Whether clarification is needed for ambiguous extractions"),
  timestamp: z.number().int().min(0).describe("Timestamp of voting result"),
});
export type VotedResultType = z.infer<typeof VotedResult>;

// ─────────────────────────────────────────────────────────
// Synthesized enrichment (synthesize-node → edit-node)
// ─────────────────────────────────────────────────────────

/**
 * SynthesizedInsight — one display-ready enrichment field.
 * key corresponds to enrichment field names (origin, hits, intercepted, etc.)
 */
/** Localized display values for all 4 supported languages. */
export const LocalizedValue = z.object({
  ru: z.string(),
  en: z.string(),
  he: z.string(),
  ar: z.string(),
});
export type LocalizedValueType = z.infer<typeof LocalizedValue>;

export const SynthesizedInsight = z.object({
  key: z
    .string()
    .describe("Enrichment field key, e.g. 'origin', 'hits', 'intercepted'"),
  value: LocalizedValue.describe(
    "Display-ready values in all 4 languages (ru/en/he/ar)",
  ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Confidence of the underlying voted insight"),
  sourceUrls: z
    .array(z.string())
    .describe("Source message URLs that contributed to this insight"),
});
export type SynthesizedInsightType = z.infer<typeof SynthesizedInsight>;

// ─────────────────────────────────────────────────────────
// Chat & Alert metadata (store)
// ─────────────────────────────────────────────────────────

export const TelegramMessage = z.object({
  chatId: z.string().min(1),
  messageId: z.number().int().min(1),
  isCaption: z.boolean(),
  language: z.string().min(2).max(5).optional(),
  /** Per-user base text in their language (for enrichment editing). */
  baseText: z.string().min(1).optional(),
  /** User tier — free users only get origin in meta reply, no inline edits. */
  tier: z.enum(["free", "pro"]).optional(),
});
export type TelegramMessageType = z.infer<typeof TelegramMessage>;

export const AlertMeta = z.object({
  alertId: z.string().min(1),
  messageId: z.number().int().min(1),
  chatId: z.string().min(1),
  isCaption: z.boolean(),
  alertTs: z.number().int().min(0),
  alertType: AlertType,
  alertAreas: z.array(z.string().min(1)),
  currentText: z.string().min(1),
});
export type AlertMetaType = z.infer<typeof AlertMeta>;

export const ChannelPost = z.object({
  channel: z.string().min(1),
  text: z.string().min(1),
  ts: z.number().int().min(0),
  messageUrl: z.url().optional(),
});
export type ChannelPostType = z.infer<typeof ChannelPost>;

export const ActiveSession = z.object({
  sessionId: z.string().min(1),
  sessionStartTs: z.number().int().min(0),
  phase: AlertType,
  phaseStartTs: z.number().int().min(0),
  latestAlertId: z.string().min(1),
  latestMessageId: z.number().int().min(1),
  latestAlertTs: z.number().int().min(0),
  chatId: z.string().min(1),
  isCaption: z.boolean(),
  currentText: z.string().min(1),
  baseText: z.string().min(1),
  alertAreas: z.array(z.string().min(1)),
  telegramMessages: z.array(TelegramMessage).optional(),
  /** Per-chat message IDs for the launch info enrichment message (message 1). */
  launchMessageIds: z.record(z.string(), z.number()).optional(),
  /** Per-chat message IDs for the post-attack analysis enrichment message (message 2). */
  analysisMessageIds: z.record(z.string(), z.number()).optional(),
});
export type ActiveSessionType = z.infer<typeof ActiveSession>;

// ─────────────────────────────────────────────────────────
// Extract & Clarify contexts
// ─────────────────────────────────────────────────────────

export const ExtractionContext = z.object({
  alertTs: z.number().int().min(0),
  alertType: AlertType,
  alertAreas: z.array(z.string().min(1)),
  alertId: z.string().min(1),
  language: z.string().min(1),
  existingEnrichment: Enrichment.optional(),
});
export type ExtractionContextType = z.infer<typeof ExtractionContext>;

export const ClarifyInput = z.object({
  alertId: z.string().min(1),
  alertAreas: z.array(z.string().min(1)),
  alertType: z.string().min(1),
  alertTs: z.number().int().min(0),
  messageId: z.number().int().min(1),
  currentText: z.string().min(1),
  existingEnrichment: Enrichment.optional(),
  extractions: z.array(ValidatedInsight),
  votedResult: VotedResult,
});
export type ClarifyInputType = z.infer<typeof ClarifyInput>;

export const ClarifyOutput = z.object({
  newPosts: z.array(ChannelPost),
  newInsights: z.array(ValidatedInsight),
  toolCallCount: z.number().int().min(0),
  clarified: z.boolean(),
});
export type ClarifyOutputType = z.infer<typeof ClarifyOutput>;

// ─────────────────────────────────────────────────────────
// Graph & enrichment input
// ─────────────────────────────────────────────────────────

export const RunEnrichmentInput = z.object({
  alertId: z.string().min(1),
  alertTs: z.number().int().min(0),
  alertType: AlertType,
  alertAreas: z.array(z.string().min(1)),
  chatId: z.string().min(1),
  messageId: z.number().int().min(1),
  isCaption: z.boolean(),
  currentText: z.string().min(1),
  telegramMessages: z.array(TelegramMessage).optional().default([]),
  /** Original session start time (early_warning time). Used for ETA computation. */
  sessionStartTs: z.number().int().min(0).optional(),
});
export type RunEnrichmentInputType = z.infer<typeof RunEnrichmentInput>;

// ─────────────────────────────────────────────────────────
// Config types
// ─────────────────────────────────────────────────────────

export type AlertTypeConfig = "early" | "red_alert" | "resolved";

export const GifMode = z.enum(["funny_cats", "none"]);
export type GifModeType = z.infer<typeof GifMode>;

// ─────────────────────────────────────────────────────────
// Helper functions
// ─────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────
// Geo hierarchy (moved from zone-priority.ts)
// ─────────────────────────────────────────────────────────

export const GeoLevel = z.enum(["zone", "city", "area", "macro", "country"]);
export type GeoLevel = z.infer<typeof GeoLevel>;

export const GeoMetadata = z.object({
  level: GeoLevel,
  city: z.string().optional(),
  area: z.string().optional(),
  macro: z.string().optional(),
});
export type GeoMetadata = z.infer<typeof GeoMetadata>;

export const ZONE_HIERARCHY: Record<string, GeoMetadata> = {
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
    macro: "מרכز",
  },
  גוש_דן: { level: "area", macro: "מרכז" },
  מרכז: { level: "macro" },
  דרום: { level: "macro" },
  צפון: { level: "macro" },
} as const;

// ─────────────────────────────────────────────────────────
// User configuration (multi-user, persisted in Redis)
// ─────────────────────────────────────────────────────────

export const UserTier = z.preprocess(
  (val) => (val === "premium" ? "pro" : val),
  z.enum(["free", "pro"]),
);
export type UserTier = "free" | "pro";

export const UserConfig = z.object({
  chatId: z.string().min(1),
  language: z.string().min(2).max(5),
  areas: z.array(z.string().min(1)).min(1),
  tier: UserTier.default("free"),
  registeredAt: z.number().int().min(0),
  lastActiveAt: z.number().int().min(0),
});
export type UserConfigType = z.infer<typeof UserConfig>;
