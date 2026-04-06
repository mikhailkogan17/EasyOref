/**
 * Synthesize Node — LLM-generated human-readable enrichment in target language.
 *
 * Takes voted consensus insights and produces SynthesizedInsight[]
 * where each entry is a display-ready key/value with confidence and source URLs.
 *
 * Also updates state.previousInsights with the current phase consensus
 * so the next phase can carry them forward into vote.
 */

import {
  type LocalizedValueType,
  type SynthesizedInsightType,
  type VotedInsightType,
  saveVotedInsights,
} from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
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

const LocalizedValueSchema = z.object({
  ru: z.string(),
  en: z.string(),
  he: z.string(),
  ar: z.string(),
});

const SynthesisOutput = z.object({
  fields: z
    .array(
      z.object({
        key: z
          .string()
          .describe(
            "Enrichment field key: origin, eta_absolute, rocket_count, is_cluster_munition, intercepted, hits, casualties, no_casualties, earlyWarningTime",
          ),
        value: LocalizedValueSchema.describe(
          "Display-ready values for all 4 languages simultaneously; for is_cluster_munition use exactly the string true or false in every language field",
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

  const alertTimeIL = new Date(alertTs).toLocaleTimeString("he-IL", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jerusalem",
  });

  // Pass raw consensus data — LLM translates to all 4 languages simultaneously
  const consensusForPrompt = Object.fromEntries(
    Object.entries(votedResult.consensus).map(([kind, vi]) => [
      kind,
      { ...vi, insightLocation: vi.insightLocation },
    ]),
  );

  const messages: BaseMessage[] = [
    new HumanMessage(
      JSON.stringify({
        alertType,
        alertTime: alertTimeIL,
        alertAreas,
        consensus: consensusForPrompt,
      }),
    ),
  ];

  const agentOpts = {
    model: preFilterModel,
    responseFormat: providerStrategy(SynthesisOutput),
    systemPrompt: `You synthesize military intelligence insights into enrichment data for a Telegram alert message.

CRITICAL: Produce ALL field values in ALL 4 languages simultaneously.
Each field's value must be a JSON object with keys: ru (Russian), en (English), he (Hebrew), ar (Arabic).
All graph internal context (consensus, areas, sources) is in English or Hebrew — do not let the input language affect output language coverage.

You receive voted consensus insights from multiple Telegram sources about an Israeli missile alert.

Each insight may have an "insightLocation" field with one of:
  - "exact_user_zone"   — news explicitly names the user's monitored zone
  - "user_macro_region" — news names a broader region containing the user's zone
  - "not_a_user_zone"    — unreachable here (dropped by vote-node before synthesis)
  - absent/undefined  — non-location insight (eta, origins, etc.)

Rules:
- origin: list countries separated by " + ", translated to each target language
- eta_absolute: absolute clock time (e.g. {ru: "~14:23", en: "~14:23", he: "~14:23", ar: "~14:23"}) when alertType is early_warning or red_alert AND consensus includes an "eta" kind. Convert minutes-from-now using alertTime as reference if needed. You MUST output eta_absolute whenever "eta" is present in consensus for those phases.
- is_cluster_munition: when consensus includes cluser_munition_used with value true, you MUST output this field with value EXACTLY {ru: "true", en: "true", he: "true", ar: "true"} (ASCII "true" in all languages). When consensus has cluser_munition_used false or absent, omit the field entirely. Never drop is_cluster_munition on a subsequent pass if consensus still has cluster munition.
- rocket_count: concise string in each language, add " (?)" suffix if confidence < 0.75
- hits:
    insightLocation="exact_user_zone" → plain translated phrase per language
    insightLocation="user_macro_region" → format per language with region name and user zone remark
- intercepted: use qualitative words in each language ("большинство" / "most" / "רוב" / "معظم")
- casualties: only populate if alertType is "resolved" and confidence >= 0.95. Strictly faithful to source text semantics.
- no_casualties: only populate if alertType is "resolved" AND casualties consensus explicitly has count=0 AND sources explicitly mention casualties status.
    Use exactly "none" if sources CONFIRM no casualties.
    Use exactly "unreported" if sources say not yet received / not confirmed.
    (Same English sentinel values in en field; translate the meaning in ru/he/ar only if you are certain of the nuance.)
- earlyWarningTime: only if alertType is "early_warning", use the alertTime value in all langs

CRITICAL — anti-neuroslop rules (NEVER violate):
- NEVER output a field where ALL language values are empty, placeholder, or neuroslop
- NEVER output rocket_count of "0" in any language — if no rockets confirmed, OMIT the field
- NEVER hallucinate city names, numbers, or details not in consensus
- NEVER rewrite casualty semantics (injuries ≠ deaths)
- NEVER substitute raw alertTime for eta_absolute without converting consensus "eta" value
- NEVER output a field with no matching consensus kind
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
    .filter((f: { key: string; value: LocalizedValueType }) => {
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
    .map((f: { key: string; value: LocalizedValueType }) => {
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
