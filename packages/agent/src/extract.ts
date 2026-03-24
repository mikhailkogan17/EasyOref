/**
 * LLM extraction — two-tier: cheap pre-filter + expensive extraction.
 */

import * as logger from "@easyoref/monitoring";
import {
  FilterOutputSchema,
  ExtractionResultSchema,
  type AlertType,
  type ChannelTracking,
  type EnrichmentData,
  type TrackedMessage,
  type ValidatedExtraction,
} from "@easyoref/shared";
import {
  config,
  getCachedExtractions,
  saveCachedExtractions,
  textHash,
  toIsraelTime,
} from "@easyoref/shared";
import { createAgent, providerStrategy } from "langchain";
import { ChatOpenRouter } from "@langchain/openrouter";

const filterModel = new ChatOpenRouter({
  apiKey: config.agent.apiKey,
  model: config.agent.filterModel,
  temperature: 0,
  maxTokens: 200,
});

const extractModel = new ChatOpenRouter({
  apiKey: config.agent.apiKey,
  model: config.agent.extractModel,
  temperature: 0,
  maxTokens: 500,
});

export const filterAgent = createAgent({
  model: filterModel,
  responseFormat: providerStrategy(FilterOutputSchema),
  systemPrompt: `You pre-filter Telegram channels for an Israeli missile alert system.
Given channels with their latest messages, identify which contain IMPORTANT military intel:
- Country of origin (where rockets/missiles launched from)
- Impact location (where they hit)
- Warhead type / cassette munitions
- Damage / destruction reports
- Interception reports (Iron Dome, David's Sling)
- Casualty / injury reports

IGNORE channels that only contain:
- Panic, speculation, or unverified rumors
- Rehashes of official alerts without new data
- General commentary without actionable facts

Return relevant channel names.`,
});

export const extractAgent = createAgent({
  model: extractModel,
  responseFormat: providerStrategy(ExtractionResultSchema),
  systemPrompt: `You analyze Telegram channel messages about a missile/rocket attack on Israel.
Extract structured data from the message.

CRITICAL — TIME VALIDATION:
- If post discusses events BEFORE alert time → time_relevance=0
- If post is generic military news not specific to THIS attack → time_relevance=0.2
- If post discusses current attack → time_relevance=1.0

MANDATORY METADATA: time_relevance, region_relevance, confidence, source_trust, tone.

PHASE-SPECIFIC:
- early_warning: Focus on country_origin, eta_refined_minutes, rocket_count, is_cassette. NOT: intercepted, hits, casualties.
- siren: Focus on country_origin, rocket_count, intercepted, sea_impact, open_area_impact. NOT: hits, casualties.
- resolved: All fields valid. Prioritize confirmed official reports.

RULES:
- Only extract concrete numbers explicitly stated. Never guess.
- If source says "all intercepted" without count, use intercepted=null, intercepted_qual="all".
- If message uses excessive caps/exclamations → tone="alarmist".
- For IDF posts about ongoing operations (not this attack) → time_relevance=0.
- CASUALTIES: Only set > 0 if text explicitly uses "killed", "dead", "fatality" (Hebrew: נהרג/מת, Russian: погиб/убит, English: killed/dead).`,
});

const getPhaseInstructions = (alertType: AlertType): string => {
  switch (alertType) {
    case "early_warning":
      return `PHASE: EARLY WARNING. Focus on country_origin, eta_refined_minutes, rocket_count, is_cassette.`;
    case "siren":
      return `PHASE: SIREN. Focus on country_origin, rocket_count, intercepted, sea_impact, open_area_impact.`;
    case "resolved":
      return `PHASE: RESOLVED. All fields valid. Prioritize confirmed official reports.`;
  }
};

export const filterChannelsCheap = async (
  tracking: ChannelTracking,
  alertAreas: string[],
  alertTs: number,
  alertType: AlertType,
): Promise<string[]> => {
  const channels = tracking.channels_with_updates;
  if (channels.length === 0) return [];

  const channelSummaries = channels
    .map((channel) => {
      const messages = channel.last_tracked_messages
        .map((message) => {
          return `  [${toIsraelTime(message.timestamp)}] ${message.text.slice(0, 200)}`;
        })
        .join("\n");
      return `${channel.channel} (${channel.last_tracked_messages.length} new):\n${messages}`;
    })
    .join("\n\n");

  const regionHint = alertAreas.length > 0 ? alertAreas.join(", ") : "Israel";

  const userPrompt =
    `Alert: ${regionHint} at ${toIsraelTime(alertTs)}, phase: ${alertType}\n\nChannels:\n${channelSummaries}`;

  try {
    const result = await filterAgent.invoke({ messages: [userPrompt] });
    const relevantChannels = result.structuredResponse?.relevant_channels ?? [];

    logger.info("Agent: cheap pre-filter", {
      total_channels: channels.length,
      relevant: relevantChannels.length,
      relevant_channels: relevantChannels,
    });

    return relevantChannels;
  } catch (err) {
    logger.warn("Agent: cheap pre-filter failed, passing all channels", {
      error: String(err),
    });
    return channels.map((channel) => channel.channel);
  }
};

export interface ExtractContext {
  alertTs: number;
  alertType: AlertType;
  alertAreas: string[];
  alertId: string;
  language: string;
  existingEnrichment?: EnrichmentData;
}

export const extractPosts = async (
  posts: TrackedMessage[],
  ctx: ExtractContext,
): Promise<ValidatedExtraction[]> => {
  if (posts.length === 0) return [];

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

  const regionHint =
    ctx.alertAreas.length > 0
      ? ctx.alertAreas.join(", ")
      : Object.keys(config.agent.areaLabels).join(", ") || "Israel";
  const alertTimeIL = toIsraelTime(ctx.alertTs);
  const nowIL = toIsraelTime(Date.now());
  const phaseInstructions = getPhaseInstructions(ctx.alertType);

  const enrichCtxParts: string[] = [];
  if (ctx.existingEnrichment?.origin)
    enrichCtxParts.push(`Origin: ${ctx.existingEnrichment.origin}`);
  if (ctx.existingEnrichment?.rocketCount)
    enrichCtxParts.push(`Rockets: ${ctx.existingEnrichment.rocketCount}`);
  if (ctx.existingEnrichment?.intercepted)
    enrichCtxParts.push(`Intercepted: ${ctx.existingEnrichment.intercepted}`);
  const enrichCtxLine =
    enrichCtxParts.length > 0
      ? `EXISTING ENRICHMENT: ${enrichCtxParts.join(", ")}\n`
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
        `${phaseInstructions}\n\n` +
        `Alert time: ${alertTimeIL} (Israel)\n` +
        `Post time:  ${postTimeIL} (Israel) ${postAgeSuffix}\n` +
        `Current time: ${nowIL} (Israel)\n` +
        `Alert region: ${regionHint}\n` +
        `UI language: ${ctx.language}\n` +
        enrichCtxLine;

      try {
        const result = await extractAgent.invoke({
          messages: [`${contextHeader}Channel: ${post.channel}\n\nMessage:\n${post.text.slice(0, 800)}`],
        });

        const extracted = result.structuredResponse;

        return {
          ...extracted,
          channel: post.channel,
          messageUrl: post.url,
          time_relevance: extracted?.time_relevance ?? 0.5,
          valid: true,
        } as ValidatedExtraction;
      } catch (err) {
        logger.warn("Agent: extraction failed", {
          channel: post.channel,
          error: String(err),
        });
        return {
          channel: post.channel,
          region_relevance: 0,
          source_trust: 0,
          tone: "neutral" as const,
          time_relevance: 0,
          confidence: 0,
          valid: false,
          reject_reason: "extraction_error",
        };
      }
    }),
  );

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
};

export const postFilter = (
  extractions: ValidatedExtraction[],
  alertId: string,
): ValidatedExtraction[] => {
  const validated = extractions.map((ext): ValidatedExtraction => {
    if (ext.time_relevance < 0.5) {
      return { ...ext, valid: false, reject_reason: "stale_post" };
    }

    const regionThreshold =
      ext.rocket_count != undefined &&
      ext.intercepted == undefined &&
      ext.intercepted_qual == undefined &&
      ext.hits_confirmed == undefined &&
      ext.casualties == undefined &&
      ext.injuries == undefined
        ? 0.3
        : 0.5;
    if (ext.region_relevance < regionThreshold) {
      return { ...ext, valid: false, reject_reason: "region_irrelevant" };
    }

    if (ext.source_trust < 0.4) {
      return { ...ext, valid: false, reject_reason: "untrusted_source" };
    }

    if (ext.tone === "alarmist") {
      return { ...ext, valid: false, reject_reason: "alarmist_tone" };
    }

    const hasData =
      ext.country_origin != undefined ||
      ext.rocket_count != undefined ||
      ext.is_cassette != undefined ||
      ext.intercepted != undefined ||
      ext.intercepted_qual != undefined ||
      ext.hits_confirmed != undefined ||
      ext.casualties != undefined ||
      ext.injuries != undefined ||
      ext.eta_refined_minutes != undefined;
    if (!hasData) {
      return { ...ext, valid: false, reject_reason: "no_data" };
    }

    const confidenceFloor = ext.rocket_count != undefined ? 0.2 : 0.3;
    if (ext.confidence < confidenceFloor) {
      return { ...ext, valid: false, reject_reason: "low_confidence" };
    }

    return { ...ext, valid: true };
  });

  const passed = validated.filter((ext) => ext.valid);
  const rejected = validated.filter((ext) => !ext.valid);

  logger.info("Agent: post-filter", {
    alertId,
    passed: passed.length,
    rejected: rejected.length,
    reasons: rejected.map((ext) => `${ext.channel}:${ext.reject_reason}`),
  });

  return validated;
};

export const _test = {
  filterAgent,
  extractAgent,
  postFilter,
} as const;
