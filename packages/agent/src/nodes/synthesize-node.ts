/**
 * Synthesize Node — LLM-generated human-readable enrichment in target language.
 *
 * Takes voted consensus insights and produces SynthesizedInsight[]
 * where each entry is a display-ready key/value with confidence and source URLs.
 *
 * Also updates state.previousInsights with the current phase consensus
 * so the next phase can carry them forward into vote.
 */

import * as logger from "@easyoref/shared/logger";
import {
  type Language,
  type SynthesizedInsightType,
  type VotedInsightType,
  config,
  saveVotedInsights,
  translateAreas,
  translateCountry,
} from "@easyoref/shared";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  providerStrategy,
} from "langchain";
import { z } from "zod";
import type { AgentStateType } from "../graph.js";
import {
  invokeWithFallback,
  preFilterFallback,
  preFilterModel,
} from "../models.js";

// ── Output schema ──────────────────────────────────────────

const SynthesisOutput = z.object({
  fields: z
    .array(
      z.object({
        key: z
          .string()
          .describe(
            "Enrichment field key: origin, eta_absolute, rocket_count, is_cluster_munition, intercepted, hits, casualties, no_casualties, earlyWarningTime",
          ),
        value: z
          .string()
          .describe(
            "Localized display-ready value; for is_cluster_munition use exactly the string true or false (English), not translated words",
          ),
      }),
    )
    .describe("Synthesized enrichment fields"),
});

// ── Node ───────────────────────────────────────────────────

export async function synthesizeNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const { votedResult, alertAreas, alertType, alertTs } = state;

  if (!votedResult || Object.keys(votedResult.consensus).length === 0) {
    logger.info("synthesize-node: no consensus to synthesize", {
      hasVotedResult: !!votedResult,
    });
    return {
      messages: [new AIMessage("synthesize-node: no consensus to synthesize")],
      synthesizedInsights: [],
    };
  }

  const lang = config.language as Language;
  const areasLocalized = translateAreas(alertAreas.join(", "), lang);

  const alertTimeIL = new Date(alertTs).toLocaleTimeString("he-IL", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jerusalem",
  });

  const langNames: Record<Language, string> = {
    ru: "Russian",
    en: "English",
    he: "Hebrew",
    ar: "Arabic",
  };

  // Translate country names in consensus for prompt context
  // Also pass insightLocation for impact/casualities so LLM can add remark
  const consensusForPrompt = Object.fromEntries(
    Object.entries(votedResult.consensus).map(([kind, vi]) => {
      if (kind === "country_origins") {
        // kind.value is string[] per schema (InsightKind discriminated union)
        const origins = vi.kind.value as string[];
        return [
          kind,
          {
            ...vi,
            kind: {
              ...vi.kind,
              value: Array.from(origins).map((c) => translateCountry(c, lang)),
            },
          },
        ];
      }
      return [kind, { ...vi, insightLocation: vi.insightLocation }];
    }),
  );

  const messages: BaseMessage[] = [
    new HumanMessage(
      JSON.stringify({
        language: langNames[lang],
        alertType,
        alertTime: alertTimeIL,
        alertAreas: areasLocalized,
        consensus: consensusForPrompt,
      }),
    ),
  ];

  const agentOpts = {
    model: preFilterModel,
    responseFormat: providerStrategy(SynthesisOutput),
    systemPrompt: `You synthesize military intelligence insights into localized enrichment data for a Telegram alert message.

Language: produce ALL text values in the language specified in the input.
You receive voted consensus insights from multiple Telegram sources about an Israeli missile alert.

Each insight may have an "insightLocation" field with one of:
  - "exact_user_zone"   — news explicitly names the user's monitored zone
  - "user_macro_region" — news names a broader region containing the user's zone
  - "not_a_user_zone"    — unreachable here (dropped by vote-node before synthesis)
  - absent/undefined  — non-location insight (eta, origins, etc.)

Rules:
- origin: list countries separated by " + ", translated to target language
- eta_absolute: absolute clock time (e.g. "~14:23") when alertType is early_warning or red_alert AND consensus includes an "eta" kind. Convert minutes-from-now using alertTime as reference if needed. You MUST output eta_absolute whenever "eta" is present in consensus for those phases — do not omit it in a later reasoning step.
- is_cluster_munition: when consensus includes cluser_munition_used with value true, you MUST output this field with value exactly "true" (ASCII). When consensus has cluser_munition_used false or absent, omit the field. Never drop is_cluster_munition on a subsequent pass if consensus still has cluster munition — keep output stable.
- rocket_count: concise string, add " (?)" suffix if confidence < 0.75
- hits:
    insightLocation="exact_user_zone" → plain: "Юг — 3 попадания"
    insightLocation="user_macro_region" → format: "<REGION_FROM_NEWS>: N попаданий (<USER_ZONE_NAME> — нет данных)"
      where REGION_FROM_NEWS is the region name from the insight value (e.g. "Центр", "Юг"),
      and USER_ZONE_NAME is the user's specific alert area (use alertAreas[0] translated).
      Example: "Центр: 3 попадания (Тель-Авив — нет данных)"
- intercepted: use qualitative words in target language ("большинство", "most", "רוב", "معظم")
- casualties: only populate if alertType is "resolved" and confidence >= 0.95.
  Apply the same insightLocation remark rule as hits.
  Keep wording strictly faithful to source text (no semantic rewrites like converting injuries into deaths). Use exact source wording when available; otherwise use concise qualitative count wording.
- no_casualties: only populate if alertType is "resolved" AND the casualities consensus explicitly has count=0 AND source texts explicitly mention casualties status.
    Output exactly "none" if sources CONFIRM no casualties (e.g. "пострадавших нет", "no injuries", "אין פצועים").
    Output exactly "unreported" if sources say not yet received / not confirmed yet (e.g. "MADA: no reports at this stage", "на данном этапе не поступало", "לא דווח על נפגעים").
    Determine which to output by reading source texts in the casualities consensus.
    Confidence threshold: 0.65. If alertType is not "resolved" or source texts don't explicitly mention casualties status, OMIT this field.
- earlyWarningTime: only if alertType is "early_warning", use the alertTime value

CRITICAL — anti-neuroslop rules (NEVER violate):
- NEVER output a field where the value is "0", "Неизвестно", "Unknown", "לא ידוע", "غير معروف", "N/A", "нет данных", "?", or any placeholder
- NEVER output rocket_count of "0" — if no rockets are confirmed, OMIT the field entirely
- NEVER invent or hallucinate city names, numbers, or details not present in the consensus data
- NEVER rewrite casualty semantics (e.g. injuries -> deaths). Preserve source meaning exactly.
- NEVER substitute raw alertTime for eta_absolute without converting the consensus "eta" value (minutes or exact_time) into a wall-clock ETA string. If no "eta" kind exists in consensus, do NOT invent eta_absolute
- If a consensus value is empty, null, or has no meaningful data → OMIT the field, do NOT include it
- Output ONLY fields that have a MATCHING consensus kind — if there is no consensus entry for a field, you MUST NOT output it
- When in doubt, omit`,
  };

  const result = await invokeWithFallback({
    agentOpts,
    fallbackModel: preFilterFallback,
    input: { messages },
    label: "synthesize-node",
  });
  const output = result.structuredResponse;
  messages.push(new AIMessage(JSON.stringify(output ?? {})));

  // Build SynthesizedInsight[] from output fields + consensus metadata
  // Post-synthesis validation: reject hallucinated fields with no consensus backing
  const consensusKinds = new Set(Object.keys(votedResult.consensus));
  const synthesized: SynthesizedInsightType[] = (output?.fields ?? [])
    .filter((f: { key: string; value: string }) => {
      const expectedKind = fieldKeyToKind(f.key);
      if (!consensusKinds.has(expectedKind)) {
        logger.warn(
          "synthesize-node: rejecting hallucinated field — no consensus backing",
          {
            key: f.key,
            expectedKind,
            availableKinds: [...consensusKinds],
          },
        );
        return false;
      }
      return true;
    })
    .map((f: { key: string; value: string }) => {
      // Find the matching consensus insight for confidence + sourceUrls
      const matchingKind = Object.entries(votedResult.consensus).find(
        ([kind]) => kind === fieldKeyToKind(f.key),
      );
      const vi: VotedInsightType | undefined = matchingKind?.[1];

      return {
        key: f.key,
        value: f.value,
        confidence: vi?.confidence ?? 0.5,
        sourceUrls:
          vi?.sources?.map((s) => s.sourceUrl ?? "").filter(Boolean) ?? [],
      };
    });

  logger.info("synthesize-node: synthesis done", {
    consensusKinds: Object.keys(votedResult.consensus),
    synthesizedKeys: synthesized.map((s) => s.key),
  });

  // Update previousInsights with current consensus for next phase
  const newPreviousInsights = Object.values(votedResult.consensus);

  // Persist to Redis for cross-job carry-forward
  await saveVotedInsights(newPreviousInsights);

  return {
    messages,
    synthesizedInsights: synthesized,
    previousInsights: newPreviousInsights,
  };
}

// ── Helpers ───────────────────────────────────────────────

/** Map synthesis field key → insight kind literal */
function fieldKeyToKind(key: string): string {
  const map: Record<string, string> = {
    origin: "country_origins",
    eta_absolute: "eta",
    rocket_count: "rocket_count",
    is_cluster_munition: "cluser_munition_used",
    intercepted: "impact",
    hits: "impact",
    casualties: "casualities",
    no_casualties: "casualities",
    earlyWarningTime: "eta",
  };
  return map[key] ?? key;
}
