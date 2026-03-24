/**
 * LLM extraction pipeline — two-tier: cheap pre-filter + expensive extraction.
 *
 * 1. Cheap model: single call — "which channels have important intel?"
 * 2. Expensive model: per-post — "extract structured data"
 * 3. Post-filter: deterministic validation on extraction results.
 */

import * as logger from "@easyoref/monitoring";
import type {
  AlertType,
  ChannelTracking,
  EnrichmentData,
  ExtractionResult,
  TrackedMessage,
  ValidatedExtraction,
} from "@easyoref/shared";
import {
  config,
  getCachedExtractions,
  saveCachedExtractions,
  textHash,
  toIsraelTime,
} from "@easyoref/shared";
import { ChatOpenAI } from "@langchain/openai";

// ── LLM instances ──────────────────────────────────────

/** Cheap model for channel pre-filtering (single call, short output) */
export function getFilterLLM(): ChatOpenAI {
  return new ChatOpenAI({
    model: config.agent.filterModel,
    configuration: {
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/mikhailkogan17/EasyOref",
        "X-Title": "EasyOref",
      },
    },
    apiKey: config.agent.apiKey,
    temperature: 0,
    maxTokens: 200,
  });
}

/** Expensive model for structured data extraction (per-post) */
export function getExtractLLM(): ChatOpenAI {
  return new ChatOpenAI({
    model: config.agent.extractModel,
    configuration: {
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/mikhailkogan17/EasyOref",
        "X-Title": "EasyOref",
      },
    },
    apiKey: config.agent.apiKey,
    temperature: 0,
    maxTokens: 500,
  });
}

// ── Cheap pre-filter ───────────────────────────────────

const FILTER_SYSTEM_PROMPT = `You pre-filter Telegram channels for an Israeli missile alert system.
Given channels with their latest messages, identify which contain IMPORTANT military intel:
- Country of origin (where rockets/missiles launched from)
- Impact location (where they hit)
- Warhead type / cassette munitions
- Weapon type (ballistic, cruise, drones)
- Damage / destruction reports
- Interception reports (Iron Dome, David's Sling)
- Casualty / injury reports

IGNORE channels that only contain:
- Panic, speculation, or unverified rumors
- Rehashes of official alerts without new data
- General commentary without actionable facts

Return ONLY valid JSON (no markdown):
{"relevant_channels": ["@channel1", "@channel2"]}
If NO channels have important intel, return: {"relevant_channels": []}`;

/**
 * Single cheap LLM call — filter channels by relevance.
 * Returns channel names containing important military intel.
 */
export async function filterChannelsCheap(
  tracking: ChannelTracking,
  alertAreas: string[],
  alertTs: number,
  alertType: AlertType,
): Promise<string[]> {
  const channels = tracking.channelsWithUpdates;
  if (channels.length === 0) return [];

  const channelSummaries = channels
    .map(
      (ch: {
        channel: string;
        lastTrackedMessages: Array<{ timestamp: number; text: string }>;
      }) => {
        const messages = ch.lastTrackedMessages
          .map(
            (m: { timestamp: number; text: string }) =>
              `  [${toIsraelTime(m.timestamp)}] ${m.text.slice(0, 200)}`,
          )
          .join("\n");
        return `${ch.channel} (${ch.lastTrackedMessages.length} new):\n${messages}`;
      },
    )
    .join("\n\n");

  const regionHint = alertAreas.length > 0 ? alertAreas.join(", ") : "Israel";

  const userPrompt =
    `Alert: ${regionHint} at ${toIsraelTime(
      alertTs,
    )}, phase: ${alertType}\n\n` + `Channels:\n${channelSummaries}`;

  try {
    const llm = getFilterLLM();
    const response = await llm.invoke([
      { role: "system", content: FILTER_SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ]);

    const raw =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);
    const text = raw
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "");
    const parsed = JSON.parse(text.trim()) as { relevant_channels: string[] };

    logger.info("Agent: cheap pre-filter", {
      total_channels: channels.length,
      relevant: parsed.relevant_channels.length,
      relevant_channels: parsed.relevant_channels,
    });

    return parsed.relevant_channels;
  } catch (err) {
    logger.warn("Agent: cheap pre-filter failed, passing all channels", {
      error: String(err),
    });
    // Fallback: pass all channels through
    return channels.map((c) => c.channel);
  }
}

// ── Expensive extraction ───────────────────────────────

const QUAL_VALUES =
  '"all"|"most"|"many"|"few"|"exists"|"none"|"more_than"|"less_than"';

/** Phase-specific extraction instructions */
export function getPhaseInstructions(alertType: AlertType): string | undefined {
  switch (alertType) {
    case "early_warning":
      return `PHASE: EARLY WARNING (radar detected launches, sirens not yet).
Focus on: countryOrigin (WHERE were rockets launched from?), eta_refined_minutes, rocketCount, isCassette.
Do NOT extract: intercepted, seaImpact, open_area_impact, hitsConfirmed, casualties, injuries — these are IMPOSSIBLE at this stage.
If a message discusses interception results, it is about a PREVIOUS attack — set timeRelevance=0.`;

    case "siren":
      return `PHASE: SIREN (rockets incoming, impact imminent).
Focus on: countryOrigin (if not known yet), rocketCount, intercepted, seaImpact, open_area_impact, isCassette.
Do NOT extract: hitsConfirmed, casualties, injuries — too early for confirmed damage reports.
If a message discusses casualties or confirmed hits, verify the timing carefully - it may be about a previous attack.`;

    case "resolved":
      return `PHASE: RESOLVED (incident over, assessing damage).
Focus on: countryOrigin, intercepted (final count), hitsConfirmed, casualties, injuries, open_area_impact.
All fields are valid at this stage. Prioritize confirmed official reports.`;
  }
}

export const EXTRACT_SYSTEM_PROMPT = `You analyze Telegram channel messages about a missile/rocket attack on Israel.
Extract structured data from the message and return ONLY valid JSON (no markdown).
All field definitions and type info are in your ExtractionResultSchema.

CRITICAL — TIME VALIDATION:
- If post discusses events BEFORE alert time → timeRelevance=0
- If post is generic military news not specific to THIS attack → timeRelevance=0.2
- If post discusses current attack → timeRelevance=1.0
- If uncertain → timeRelevance=0.5

MANDATORY METADATA (ALWAYS INCLUDE):
- timeRelevance, regionRelevance, confidence, sourceTrust, tone.
- These fields MUST always be present in the JSON. Never omit them.
- Use numbers (0.0 to 1.0) for relevance/confidence/trust and strings for tone.

PHASE-SPECIFIC CONSTRAINTS:
- If unrelated to the alert region, set regionRelevance=0 and all data fields to null.
- If message is speculative/unconfirmed rumor, set sourceTrust < 0.4.
- If message uses excessive caps, exclamation marks, panic language → tone="alarmist".
- Only extract concrete numbers explicitly stated in the text. Never guess.
- NEVER invent specific interception numbers. If source says "all intercepted" without a count, use intercepted=null, interceptedQual="all". If source says "no impacts" without specifying interceptions, set hitsConfirmed=0 and intercepted=null.
- rocketDetail: If the source splits rocket count by region (e.g. "2 to the center, 3 to the north"), put the regional breakdown in rocketDetail and the TOTAL in rocketCount. If no regional split, set rocketDetail=null.
- hit_location: If hitsConfirmed > 0, prefer SPECIFIC city/town names over macro-regions (e.g. "Рамле" > "Центр", "Ришон-ле-Цион" > "Гуш-Дан"). Use macro-region ONLY if no specific city is mentioned. null if unknown or hitsConfirmed == 0.
- hit_type: "direct" (direct hit on structure/infrastructure) | "shrapnel" (debris/fragments/shrapnel). null if unknown or hitsConfirmed == 0.
- hit_detail: If hitsConfirmed > 0, describe WHERE/HOW the impact occurred. Examples: "на открытой местности" (open area), "здание" (building), "в море" (sea), "без разрушений" (no damage). Must be written in UI language. Translate appropriately: "שטח פתוח" → "на открытой местности", "נפילה בשטח פתוח" → "на открытой местности". null if unknown or hitsConfirmed == 0.
- LANGUAGE: rocketDetail, hit_location, hit_detail MUST be written in the UI language (see context header). Translate from Hebrew/Arabic/English as needed. Do NOT output verbatim Hebrew if UI language is Russian, etc.
- *_qual fields: use ONLY when NO exact count is given. If exact number present, set *_qual=null.
- "none" qual is only valid if explicitly stated (e.g., "все перехвачены", "не упало в море").
- For IDF (@idf_telegram) posts about ongoing operations (not this specific attack) → timeRelevance=0.
- CASUALTIES — HIGHEST THRESHOLD: Only set casualties > 0 if the source text EXPLICITLY uses words
  meaning "killed", "dead", "died", "fatality" (Hebrew: נהרג/מת/קטל; Russian: погиб/убит/смерть;
  English: killed/dead/died/fatality). NEVER infer deaths from "serious injury", "critical condition",
  or "suspected". If you are not 100% certain the word is in the source, set casualties=null.
  confidence for casualties MUST be >= 0.95 or set to null.
- INJURY RETRACTIONS: If a source explicitly states "no injured", "false report of injury",
  "ложное сообщение о раненом", "אין פצועים", set injuries=0 with high confidence (>= 0.8).
  This overrides earlier injury reports.
- INJURIES CAUSE: injuries_cause distinguishes:
  - "rocket" = injured by rocket fragment, blast, or structural damage from impact
  - "rushing_to_shelter" = injured while running to shelter (fell, stampede, heart attack, panic)
  - null = unknown or no injuries. ALWAYS set this when injuries > 0.
- GEO-RELEVANCE FOR HITS: hitsConfirmed, hit_location, hit_detail and hit_type must refer to
  the CONFIGURED ALERT ZONE only. If the source describes damage/debris in a DIFFERENT city
  or area (e.g., Rishon LeZion when the zone is Tel Aviv South), set hit_location to that city
  name with a note, set regionRelevance proportionally lower, and describe the actual location
  in hit_detail. Do NOT report hits as "confirmed" in the alert zone if the source says a
  different city. If the damage is in a nearby but different city (~10-30km), report it in
  hit_detail as "<city> (~Xкм)".
- LANGUAGE NEUTRALITY: Posts may be in Hebrew, Russian, Arabic, or English. The language of the post
  MUST NOT affect sourceTrust or confidence. Russian-language Israeli channels are equally reliable
  and often break news faster than Hebrew ones. Judge ONLY by factual content and tone.
- TRUST INTERCEPTION & IMPACT REPORTS: When a channel explicitly states interception results
  (e.g., "перехвачены", "intercepted", "יירוט", "упали в море", "fell in the sea", "נפלו בים",
  "open area impact", "שטח פתוח"), trust these claims with sourceTrust >= 0.7 and confidence >= 0.7.
  Israeli Telegram channels often report interception results before official confirmation,
  and these reports are typically accurate. Do NOT downgrade these just because they lack official source.
- EXISTING ENRICHMENT CROSS-REFERENCE: If the context includes "EXISTING ENRICHMENT", previous phases
  already established facts with high confidence. Cross-reference against them:
  - If this post discusses a DIFFERENT countryOrigin than what’s established, be skeptical.
    Security officials summarizing past operations or different events should get timeRelevance=0.
  - Only override existing enrichment if this post has DIRECT, specific information about the current attack.
  - General security news that appeared right after a siren but doesn't mention THIS specific attack = timeRelevance=0.
- OFFICIAL PHASE ANNOUNCEMENTS ≠ INCIDENT DATA: Messages from IDF / Home Front Command (Pikud HaOref)
  that announce alert phases — "siren issued", "alert in effect", "can leave the shelter", "all clear" —
  are ADMINISTRATIVE NOTICES. They say nothing about rocket count, country of origin, interceptions,
  hits, casualties, or damage. Extract NO data fields from these messages. Set timeRelevance=0 and
  all data fields to null.`;

export interface ExtractContext {
  alertTs: number;
  alertType: AlertType;
  alertAreas: string[];
  alertId: string;
  language: string;
  /** Existing enrichment from earlier phases — for cross-reference */
  existingEnrichment?: EnrichmentData;
}

/**
 * Extract structured data from posts using expensive LLM.
 * Uses post-level dedup cache to avoid re-extracting unchanged posts.
 */
export async function extractPosts(
  posts: TrackedMessage[],
  ctx: ExtractContext,
): Promise<ValidatedExtraction[]> {
  if (posts.length === 0) return [];

  // ── Post-level dedup ───────────────────────────────
  const postHashMap = new Map<string, TrackedMessage>();
  for (const post of posts) {
    const hash = textHash(post.channel + "|" + post.text.slice(0, 800));
    postHashMap.set(hash, post);
  }

  const allHashes = [...postHashMap.keys()];
  const cached = await getCachedExtractions(allHashes);

  const cachedResults: ValidatedExtraction[] = [];
  const newPosts: TrackedMessage[] = [];

  for (const [hash, post] of postHashMap) {
    const cachedJson = cached.get(hash);
    if (cachedJson) {
      cachedResults.push(JSON.parse(cachedJson) as ValidatedExtraction);
    } else {
      newPosts.push(post);
    }
  }

  logger.info("Agent: extraction dedup", {
    alertId: ctx.alertId,
    total: posts.length,
    cached: cachedResults.length,
    new: newPosts.length,
  });

  if (newPosts.length === 0) {
    return cachedResults;
  }

  // ── Extract new posts ──────────────────────────────
  const llm = getExtractLLM();

  const regionHint =
    ctx.alertAreas.length > 0
      ? ctx.alertAreas.join(", ")
      : Object.keys(config.agent.areaLabels).join(", ") || "Israel";
  const alertTimeIL = toIsraelTime(ctx.alertTs);
  const nowIL = toIsraelTime(Date.now());
  const phaseInst = getPhaseInstructions(ctx.alertType);
  const systemPrompt = EXTRACT_SYSTEM_PROMPT + "\n\n" + phaseInst;

  // Build existing enrichment context line for cross-reference
  const enrichCtxParts: string[] = [];
  if (ctx.existingEnrichment?.origin)
    enrichCtxParts.push(`Origin: ${ctx.existingEnrichment.origin}`);
  if (ctx.existingEnrichment?.rocketCount)
    enrichCtxParts.push(`Rockets: ${ctx.existingEnrichment.rocketCount}`);
  if (ctx.existingEnrichment?.intercepted)
    enrichCtxParts.push(`Intercepted: ${ctx.existingEnrichment.intercepted}`);
  const enrichCtxLine =
    enrichCtxParts.length > 0
      ? `EXISTING ENRICHMENT (from earlier phases): ${enrichCtxParts.join(
          ", ",
        )}\n`
      : "";

  const newResults = await Promise.all(
    newPosts.map(async (post): Promise<ValidatedExtraction> => {
      const postTimeIL = toIsraelTime(post.timestamp);
      const postAgeMin = Math.round((ctx.alertTs - post.timestamp) / 60_000);
      const postAgeSuffix =
        postAgeMin > 0
          ? `(${postAgeMin} min BEFORE alert)`
          : postAgeMin < 0
          ? `(${Math.abs(postAgeMin)} min AFTER alert)`
          : "(same time as alert)";

      const contextHeader =
        `Alert time: ${alertTimeIL} (Israel)\n` +
        `Post time:  ${postTimeIL} (Israel) ${postAgeSuffix}\n` +
        `Current time: ${nowIL} (Israel)\n` +
        `Alert region: ${regionHint}\n` +
        `UI language: ${ctx.language}\n` +
        enrichCtxLine;

      try {
        const response = await llm.invoke([
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `${contextHeader}Channel: ${
              post.channel
            }\n\nMessage:\n${post.text.slice(0, 800)}`,
          },
        ]);

        const raw =
          typeof response.content === "string"
            ? response.content
            : JSON.stringify(response.content);
        const text = raw
          .replace(/^```(?:json)?\s*\n?/i, "")
          .replace(/\n?```\s*$/i, "");
        const rawParsed = JSON.parse(text.trim());
        const parsed = Object.fromEntries(
          Object.entries(rawParsed).filter(([_, v]) => v !== null),
        ) as ExtractionResult;
        return {
          ...parsed,
          channel: post.channel,
          messageUrl: post.url,
          timeRelevance: parsed.timeRelevance ?? 0.5,
          valid: true,
        };
      } catch (err) {
        logger.warn("Agent: extraction failed", {
          channel: post.channel,
          error: String(err),
        });
        return {
          channel: post.channel,
          regionRelevance: 0,
          sourceTrust: 0,
          tone: "neutral" as const,
          timeRelevance: 0,
          confidence: 0,
          valid: false,
          rejectReason: "extraction_error",
        };
      }
    }),
  );

  // Cache new results
  const cacheEntries: Record<string, string> = {};
  newPosts.forEach((post, i) => {
    const hash = textHash(post.channel + "|" + post.text.slice(0, 800));
    cacheEntries[hash] = JSON.stringify(newResults[i]);
  });
  await saveCachedExtractions(cacheEntries);

  const results = [...cachedResults, ...newResults];

  logger.info("Agent: extracted", {
    alertId: ctx.alertId,
    count: results.length,
    newLLMCalls: newResults.length,
    cachedReused: cachedResults.length,
  });

  return results;
}

// ── Post-filter (deterministic, 0 tokens) ──────────────

/**
 * Deterministic validation of extraction results.
 * Rejects: stale posts, irrelevant regions, untrusted sources,
 * alarmist tone, no data, low confidence.
 */
export function postFilter(
  extractions: ValidatedExtraction[],
  alertId: string,
): ValidatedExtraction[] {
  const validated = extractions.map((ext): ValidatedExtraction => {
    // V0: TIME RELEVANCE — most important check
    if (ext.timeRelevance < 0.5) {
      return { ...ext, valid: false, rejectReason: "stale_post" };
    }
    // V1: region relevance — relaxed for rocketCount-only posts (national totals are valid)
    const regionThreshold =
      ext.rocketCount != undefined &&
      ext.intercepted == undefined &&
      ext.interceptedQual == undefined &&
      ext.hitsConfirmed == undefined &&
      ext.casualties == undefined &&
      ext.injuries == undefined
        ? 0.3
        : 0.5;
    if (ext.regionRelevance < regionThreshold) {
      return { ...ext, valid: false, rejectReason: "region_irrelevant" };
    }
    // V2: source trust
    if (ext.sourceTrust < 0.4) {
      return { ...ext, valid: false, rejectReason: "untrusted_source" };
    }
    // V3: tone — reject alarmist
    if (ext.tone === "alarmist") {
      return { ...ext, valid: false, rejectReason: "alarmist_tone" };
    }
    // V4: at least one data field must be non-undefined
    const hasData =
      ext.countryOrigin != undefined ||
      ext.rocketCount != undefined ||
      ext.isCassette != undefined ||
      ext.intercepted != undefined ||
      ext.interceptedQual != undefined ||
      ext.hitsConfirmed != undefined ||
      ext.casualties != undefined ||
      ext.injuries != undefined ||
      ext.etaRefinedMinutes != undefined;
    if (!hasData) {
      return { ...ext, valid: false, rejectReason: "no_data" };
    }
    // V5: overall confidence floor
    // Rocket count posts get a lower floor (0.2) — national totals are high-value even if uncertain
    const confidenceFloor = ext.rocketCount != undefined ? 0.2 : 0.3;
    if (ext.confidence < confidenceFloor) {
      return { ...ext, valid: false, rejectReason: "low_confidence" };
    }

    return { ...ext, valid: true };
  });

  const passed = validated.filter((e) => e.valid);
  const rejected = validated.filter((e) => !e.valid);

  logger.info("Agent: post-filter", {
    alertId,
    passed: passed.length,
    rejected: rejected.length,
    reasons: rejected.map((r) => `${r.channel}:${r.rejectReason}`),
  });

  return validated;
}

// ── Exported for testing ───────────────────────────────

export const _test = {
  getFilterLLM,
  getExtractLLM,
  getPhaseInstructions,
  EXTRACT_SYSTEM_PROMPT,
  FILTER_SYSTEM_PROMPT,
  postFilter,
} as const;
