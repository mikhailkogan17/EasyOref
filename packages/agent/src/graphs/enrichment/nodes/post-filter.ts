/**
 * Post-Filter Node — LLM-based source verification.
 *
 * Verifies each extracted insight against the source post text (already in memory).
 * No HTTP fetch required — source.text comes directly from the NewsMessage.
 */

import type {
  InsightLocationType,
  InsightType,
  ValidatedInsightType as ValidatedInsight,
} from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  providerStrategy,
} from "langchain";
import { z } from "zod";
import {
  extractFallback,
  extractModel,
  invokeWithFallback,
} from "../../../models.js";
import { resolveArea } from "../../../utils/resolve-area.js";
import type { AgentStateType } from "../enrichment-graph.js";

/**
 * Local typed view of InsightType fields that post-filter-node reads.
 * InsightKind is a discriminated union, so we can't directly access
 * location/area/zone/extractionReason at the union level — they are present
 * at runtime (set by the LLM) but not in the base schema.
 */
interface InsightWithExtras extends Omit<InsightType, "kind" | "source"> {
  extractionReason?: string;
  kind: InsightType["kind"] & {
    value?: unknown;
    location?: string;
    area?: string;
    zone?: string;
  };
  source: InsightType["source"] & {
    text?: string;
    channelId?: string;
  };
}

const LOCATION_INSIGHT_KINDS = new Set(["impact", "casualities"]);

// ── Schema ─────────────────────────────────────────────────

const SourceVerification = z.object({
  supported: z
    .boolean()
    .describe("Does the source post text actually support this insight?"),
  reason: z.string().describe("One-sentence explanation"),
  sourceTrust: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "Trust score for this source channel (0=unknown/unreliable, 1=authoritative IDF/N12)",
    ),
});

// ── Agent options ──────────────────────────────────────────

const postFilterAgentOpts = {
  model: extractModel,
  responseFormat: providerStrategy(SourceVerification),
  systemPrompt: `You verify whether a Telegram channel post actually supports a specific military intelligence claim.
Given the post text and the extracted insight, determine if the post clearly contains evidence for this claim.
Be strict: only return supported=true if the claim is clearly present in the post text.
Also assign sourceTrust: IDF Spokesperson/N12/Kan = 0.9+; known mil channels = 0.7; unknown = 0.4.`,
};

// ── Node ───────────────────────────────────────────────────

export const postFilterNode = async (
  state: AgentStateType,
): Promise<Partial<AgentStateType>> => {
  const { extractedInsights } = state;

  if (!extractedInsights || extractedInsights.length === 0) {
    logger.info("post-filter-node: no extractions to verify");
    return {
      messages: [new AIMessage("post-filter-node: no extractions to verify")],
    };
  }

  const allMessages: BaseMessage[] = [];
  const validatedInsights: ValidatedInsight[] = [];
  let validCount = 0;
  let invalidCount = 0;

  for (const rawInsight of extractedInsights) {
    // Cast to typed view so we can access LLM-populated optional fields without `as any`
    const insight = rawInsight as unknown as InsightWithExtras;
    const sourceText = insight.source.text ?? "";

    if (!sourceText) {
      // No source text — mark invalid without LLM call
      validatedInsights.push({
        ...rawInsight,
        isValid: false,
        rejectionReason: "source_text_missing",
        sourceTrust: 0,
      });
      invalidCount++;
      continue;
    }

    const messages: BaseMessage[] = [
      new HumanMessage(
        JSON.stringify({
          insight: {
            kind: insight.kind.kind,
            value: insight.kind.value,
            extractionReason: insight.extractionReason,
          },
          sourceChannel: insight.source.channelId,
          sourceText,
        }),
      ),
    ];

    const result = await invokeWithFallback({
      agentOpts: postFilterAgentOpts,
      fallbackModel: extractFallback,
      input: { messages },
      label: "post-filter-node",
    });
    const verification = result.structuredResponse;
    messages.push(new AIMessage(JSON.stringify(verification ?? {})));
    allMessages.push(...messages);

    if (verification?.supported) {
      const insightKind = insight.kind.kind as string;
      let insightLocation: InsightLocationType | undefined = undefined;

      if (LOCATION_INSIGHT_KINDS.has(insightKind)) {
        // Extract mentioned location from insight value
        const mentionedLocation: string =
          insight.kind.location ?? insight.kind.area ?? insight.kind.zone ?? "";

        if (mentionedLocation && state.alertAreas.length > 0) {
          const areaResult = await resolveArea(
            mentionedLocation,
            state.alertAreas,
          );
          if (!areaResult.relevant) {
            // Region has zero overlap with user zones — mark invalid to drop in vote
            validatedInsights.push({
              ...rawInsight,
              isValid: false,
              rejectionReason: `location_not_user_zone: "${mentionedLocation}" not in user areas`,
              sourceTrust: verification.sourceTrust ?? 0.5,
              insightLocation: "not_a_user_zone" satisfies InsightLocationType,
            });
            invalidCount++;
            continue;
          }
          // exact tier = user's specific zone confirmed; any other tier = broader macro region
          insightLocation =
            areaResult.tier === "exact"
              ? "exact_user_zone"
              : "user_macro_region";
        }
      }

      validatedInsights.push({
        ...rawInsight,
        isValid: true,
        sourceTrust: verification.sourceTrust ?? 0.5,
        timeRelevance: rawInsight.timeRelevance ?? 1,
        regionRelevance: rawInsight.regionRelevance ?? 1,
        insightLocation,
      });
      validCount++;
    } else if (
      state.alertType === "early_warning" ||
      state.alertType === "red_alert"
    ) {
      // Soft pass during critical phases — LLM verification is unreliable on
      // free models, but dropping insights during active attack is worse.
      // Low confidence + trust lets vote-node apply consensus logic.
      validatedInsights.push({
        ...rawInsight,
        isValid: true,
        rejectionReason: "soft_pass_critical_phase",
        sourceTrust: 0.2,
        confidence: rawInsight.confidence ?? 0.3,
        timeRelevance: rawInsight.timeRelevance ?? 0.5,
        regionRelevance: rawInsight.regionRelevance ?? 0.5,
      });
      validCount++;
    } else {
      validatedInsights.push({
        ...rawInsight,
        isValid: false,
        rejectionReason: verification?.reason ?? "source_verification_failed",
        sourceTrust: verification?.sourceTrust ?? 0,
        timeRelevance: rawInsight.timeRelevance ?? 0,
        regionRelevance: rawInsight.regionRelevance ?? 0,
      });
      invalidCount++;
    }
  }

  allMessages.push(
    new AIMessage(
      JSON.stringify({
        node: "post-filter",
        total: validatedInsights.length,
        valid: validCount,
        invalid: invalidCount,
      }),
    ),
  );

  logger.info("post-filter-node: verification done", {
    total: validatedInsights.length,
    valid: validCount,
    invalid: invalidCount,
  });

  return {
    messages: allMessages,
    filteredInsights: validatedInsights,
  };
};
