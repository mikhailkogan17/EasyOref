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
  type Language,
  type SynthesizedInsightType,
  type VotedInsightType,
  config,
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
import { invokeWithFallback, preFilterFallback, preFilterModel } from "../models.js";

// ── Output schema ──────────────────────────────────────────

const SynthesisOutput = z.object({
  fields: z
    .array(
      z.object({
        key: z
          .string()
          .describe(
            "Enrichment field key: origin, eta_absolute, rocket_count, is_cassette, intercepted, hits, casualties, earlyWarningTime",
          ),
        value: z.string().describe("Localized display-ready value"),
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
- eta_absolute: absolute clock time (e.g. "~14:23") only if alertType is early_warning or red_alert
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
- earlyWarningTime: only if alertType is "early_warning", use the alertTime value
- omit fields where there is no evidence
- output only fields for which you have consensus data`,
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
  const synthesized: SynthesizedInsightType[] = (output?.fields ?? []).map(
    (f: { key: string; value: string }) => {
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
    },
  );

  // Update previousInsights with current consensus for next phase
  const newPreviousInsights = Object.values(votedResult.consensus);

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
    is_cassette: "cluser_munition_used",
    intercepted: "impact",
    hits: "impact",
    casualties: "casualities",
    earlyWarningTime: "eta",
  };
  return map[key] ?? key;
}
