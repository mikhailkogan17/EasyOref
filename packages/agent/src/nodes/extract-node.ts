/**
 * Extract Node — LLM extraction from relevant channels.
 */

import * as logger from "@easyoref/monitoring";
import {
  ExtractionResultSchema,
  FilterOutputSchema,
  type AlertType,
  type TrackedMessage,
  type ValidatedExtraction,
} from "@easyoref/shared";
import {
  config,
  getCachedExtractions,
  saveCachedExtractions,
  setLastUpdateTs,
  textHash,
  toIsraelTime,
} from "@easyoref/shared";
import { createAgent, providerStrategy } from "langchain";
import { ChatOpenRouter } from "@langchain/openrouter";
import type { AgentStateType } from "../graph.js";

const extractModel = new ChatOpenRouter({
  apiKey: config.agent.apiKey,
  model: config.agent.extractModel,
  temperature: 0,
  maxTokens: 500,
});

const filterModel = new ChatOpenRouter({
  apiKey: config.agent.apiKey,
  model: config.agent.filterModel,
  temperature: 0,
  maxTokens: 200,
});

export const filterAgent = createAgent({
  model: filterModel,
  responseFormat: providerStrategy(FilterOutputSchema),
  systemPrompt: `You pre-filter Telegram channels for an Israeli missile alert system.
Given channels with their latest messages, identify which contain IMPORTANT military intel.
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

export const extractNode = async (
  state: AgentStateType,
): Promise<Partial<AgentStateType>> => {
  if (!state.tracking || state.tracking.channels_with_updates.length === 0) {
    logger.info("Agent: no channels with updates", { alertId: state.alertId });
    return { extractions: [] };
  }

  const channels = state.tracking.channels_with_updates;
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

  const regionHint = state.alertAreas.length > 0 ? state.alertAreas.join(", ") : "Israel";
  const alertTime = toIsraelTime(state.alertTs);
  const userPrompt = `Alert: ${regionHint} at ${alertTime}, phase: ${state.alertType}\n\nChannels:\n${channelSummaries}`;

  let relevantChannels: string[] = [];
  try {
    const result = await filterAgent.invoke({ messages: [userPrompt] });
    relevantChannels = result.structuredResponse?.relevant_channels ?? [];
  } catch {
    relevantChannels = channels.map((c) => c.channel);
  }

  if (relevantChannels.length === 0) {
    return { extractions: [] };
  }

  const postsToExtract: TrackedMessage[] = [];
  for (const channel of channels) {
    const match = relevantChannels.some(
      (rc: string) =>
        rc === channel.channel ||
        rc === `@${channel.channel}` ||
        `@${rc}` === channel.channel,
    );
    if (match) {
      postsToExtract.push(...channel.last_tracked_messages);
    }
  }

  if (postsToExtract.length === 0) {
    return { extractions: [] };
  }

  const postHashMap = new Map<string, TrackedMessage>();
  for (const post of postsToExtract) {
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

  if (newPosts.length === 0) {
    const filtered = postFilter(cachedResults, state.alertId);
    return { extractions: filtered };
  }

  const alertTimeIL = toIsraelTime(state.alertTs);
  const nowIL = toIsraelTime(Date.now());
  const phaseInstructions = getPhaseInstructions(state.alertType);

  const enrichCtxParts: string[] = [];
  if (state.previousEnrichment?.origin) {
    enrichCtxParts.push(`Origin: ${state.previousEnrichment.origin}`);
  }
  if (state.previousEnrichment?.rocketCount) {
    enrichCtxParts.push(`Rockets: ${state.previousEnrichment.rocketCount}`);
  }
  if (state.previousEnrichment?.intercepted) {
    enrichCtxParts.push(`Intercepted: ${state.previousEnrichment.intercepted}`);
  }
  const enrichCtxLine = enrichCtxParts.length > 0
    ? `EXISTING ENRICHMENT: ${enrichCtxParts.join(", ")}\n`
    : "";

  const newResults = await Promise.all(
    newPosts.map(async (post): Promise<ValidatedExtraction> => {
      const postTimeIL = toIsraelTime(post.timestamp);
      const postAgeMin = Math.round((state.alertTs - post.timestamp) / 60_000);
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
        `UI language: ${config.language}\n` +
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
      } catch {
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
  const filtered = postFilter(results, state.alertId);

  await setLastUpdateTs(Date.now());

  return { extractions: filtered };
};

export const _test = {
  extractAgent,
  filterAgent,
  postFilter,
} as const;
