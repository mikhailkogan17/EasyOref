/**
 * Synthesize Node — voting + LLM synthesis in a single node.
 *
 * Merges filteredInsights (new) + previousInsights (carry-forward),
 * picks best consensus per kind (deterministic voting), then
 * produces SynthesizedInsight[] with localized display values.
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
import type { AgentStateType } from "../enrichment-graph.js";
import {
  invokeWithFallback,
  preFilterFallback,
  preFilterModel,
} from "../../../models.js";
import { buildConsensus } from "../../../utils/consensus.js";
import { fieldKeyToKind } from "../../../utils/field-key-map.js";
import { applyGuardrails } from "../../../utils/guardrails.js";

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

// ── Agent options (top-level) ──────────────────────────────

const synthesizeAgentOpts = {
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

// ── Node ───────────────────────────────────────────────────

export async function synthesizeNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const {
    filteredInsights = [],
    previousInsights = [],
    alertAreas,
    alertType,
    alertTs,
  } = state;

  // Step 1: deterministic voting (0 tokens)
  const votedResult = buildConsensus(filteredInsights, previousInsights);

  if (Object.keys(votedResult.consensus).length === 0) {
    logger.info("synthesize-node: no consensus to synthesize", {
      filteredTotal: filteredInsights.length,
      previousTotal: previousInsights.length,
    });
    return {
      messages: [new AIMessage("synthesize-node: no consensus to synthesize")],
      votedResult,
      synthesizedInsights: [],
    };
  }

  // Step 2: LLM synthesis
  const alertTimeIL = new Date(alertTs).toLocaleTimeString("he-IL", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jerusalem",
  });

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

  const result = await invokeWithFallback({
    agentOpts: synthesizeAgentOpts,
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

  // Step 3: guardrails — reject neuroslop, overlong, sourceless fields
  const { passed: guarded, rejected } = applyGuardrails(synthesized);
  if (rejected.length > 0) {
    logger.warn("synthesize-node: guardrails rejected fields", {
      rejected: rejected.map((r) => ({ key: r.insight.key, reason: r.reason })),
    });
  }

  // Update previousInsights with current consensus for next phase
  const newPreviousInsights = Object.values(votedResult.consensus);

  // Persist to Redis for cross-job carry-forward
  await saveVotedInsights(newPreviousInsights);

  return {
    messages,
    votedResult,
    synthesizedInsights: guarded,
    previousInsights: newPreviousInsights,
  };
}
