/**
 * Post-Filter Node — LLM-based source verification.
 *
 * Verifies each extracted insight against the source post text (already in memory).
 * No HTTP fetch required — source.text comes directly from the NewsMessage.
 */

import type {
  InsightLocationType,
  ValidatedInsightType as ValidatedInsight,
} from "@easyoref/shared";
import { config } from "@easyoref/shared";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  providerStrategy,
} from "langchain";
import { z } from "zod";
import type { AgentStateType } from "../graph.js";
import { extractFallback, extractModel, invokeWithFallback } from "../models.js";
import { resolveArea } from "../tools/resolve-area.js";

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

// ── Node ───────────────────────────────────────────────────

export const postFilterNode = async (
  state: AgentStateType,
): Promise<Partial<AgentStateType>> => {
  const { extractedInsights } = state;

  if (!extractedInsights || extractedInsights.length === 0) {
    return {
      messages: [new AIMessage("post-filter-node: no extractions to verify")],
    };
  }

  const allMessages: BaseMessage[] = [];
  const validatedInsights: ValidatedInsight[] = [];
  let validCount = 0;
  let invalidCount = 0;

  const agentOpts = {
    model: extractModel,
    responseFormat: providerStrategy(SourceVerification),
    systemPrompt: `You verify whether a Telegram channel post actually supports a specific military intelligence claim.
Given the post text and the extracted insight, determine if the post clearly contains evidence for this claim.
Be strict: only return supported=true if the claim is clearly present in the post text.
Also assign sourceTrust: IDF Spokesperson/N12/Kan = 0.9+; known mil channels = 0.7; unknown = 0.4.`,
  };

  for (const insight of extractedInsights) {
    const sourceText = (insight.source as any).text ?? "";

    if (!sourceText) {
      // No source text — mark invalid without LLM call
      validatedInsights.push({
        ...(insight as any),
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
            value: (insight.kind as any).value,
            extractionReason: (insight as any).extractionReason,
          },
          sourceChannel: (insight.source as any).channelId,
          sourceText,
        }),
      ),
    ];

    const result = await invokeWithFallback({
      agentOpts,
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
          (insight.kind as any).location ??
          (insight.kind as any).area ??
          (insight.kind as any).zone ??
          "";

        if (mentionedLocation && config.areas.length > 0) {
          const areaResult = await resolveArea(mentionedLocation, config.areas);
          if (!areaResult.relevant) {
            // Region has zero overlap with user zones — mark invalid to drop in vote
            validatedInsights.push({
              ...(insight as any),
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
        ...(insight as any),
        isValid: true,
        sourceTrust: verification.sourceTrust ?? 0.5,
        timeRelevance: (insight as any).timeRelevance ?? 1,
        regionRelevance: (insight as any).regionRelevance ?? 1,
        insightLocation,
      });
      validCount++;
    } else {
      validatedInsights.push({
        ...(insight as any),
        isValid: false,
        rejectionReason: verification?.reason ?? "source_verification_failed",
        sourceTrust: verification?.sourceTrust ?? 0,
        timeRelevance: (insight as any).timeRelevance ?? 0,
        regionRelevance: (insight as any).regionRelevance ?? 0,
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

  return {
    messages: allMessages,
    filteredInsights: validatedInsights,
  };
};
