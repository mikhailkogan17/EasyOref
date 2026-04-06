/**
 * Vote Node — consensus voting over ValidatedInsight[], deterministic, 0 tokens.
 *
 * Merges state.filteredInsights (new) + state.previousInsights (carry-forward)
 * into a single consensus per insight kind.
 *
 * For each kind:
 * - Collect all ValidatedInsights + previousInsights for that kind
 * - Group by JSON-serialized value
 * - Compute weighted avg confidence
 * - Pick highest-confidence option as consensus
 * - Build VotedInsight with sources: BaseSourceMessage[]
 */

import * as logger from "@easyoref/shared/logger";
import type {
  BaseSourceMessageType,
  InsightLocationType,
  ValidatedInsightType,
  VotedInsightType,
  VotedResultType,
} from "@easyoref/shared";
import { getClarifyNeed } from "@easyoref/shared";
import { AIMessage } from "langchain";
import type { AgentStateType } from "../graph.js";

// ── Internal grouping helpers ──────────────────────────────

interface InsightOption {
  kind: ValidatedInsightType["kind"];
  sources: BaseSourceMessageType[];
  avgConfidence: number;
  avgSourceTrust: number;
  avgTimeRelevance: number;
  avgRegionRelevance: number;
  insightLocation: InsightLocationType | undefined;
  insights: ValidatedInsightType[];
}

interface DroppedKindInfo {
  kind: string;
  reason: string;
  candidateCount: number;
}

function groupInsightsByKind(
  insights: ValidatedInsightType[],
): Map<string, ValidatedInsightType[]> {
  const map = new Map<string, ValidatedInsightType[]>();
  for (const i of insights) {
    const k = i.kind.kind;
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(i);
  }
  return map;
}

function computeOptions(group: ValidatedInsightType[]): InsightOption[] {
  // Sub-group by serialized value
  const valueMap = new Map<string, ValidatedInsightType[]>();
  for (const i of group) {
    const key = JSON.stringify(i.kind);
    if (!valueMap.has(key)) valueMap.set(key, []);
    valueMap.get(key)!.push(i);
  }

  const options: InsightOption[] = [];
  for (const [, sub] of valueMap) {
    if (!sub.length) continue;
    const avg = (fn: (i: ValidatedInsightType) => number) =>
      sub.reduce((s, i) => s + fn(i), 0) / sub.length;

    options.push({
      kind: sub[0]!.kind,
      sources: sub.map((i) => i.source as BaseSourceMessageType),
      avgConfidence: avg((i) => i.confidence ?? 0),
      avgSourceTrust: avg((i) => i.sourceTrust ?? 0),
      avgTimeRelevance: avg((i) => i.timeRelevance),
      avgRegionRelevance: avg((i) => i.regionRelevance),
      // exact_user_zone wins if any source confirms it; user_macro_region if any source says broader;
      // not_a_user_zone if all sources say no overlap; undefined if non-location insight
      insightLocation: sub.some((i) => i.insightLocation === "exact_user_zone")
        ? "exact_user_zone"
        : sub.some((i) => i.insightLocation === "user_macro_region")
        ? "user_macro_region"
        : sub.some((i) => i.insightLocation === "not_a_user_zone")
        ? "not_a_user_zone"
        : undefined,
      insights: sub,
    });
  }

  options.sort((a, b) => b.avgConfidence - a.avgConfidence);
  return options;
}

// ── Node ───────────────────────────────────────────────────

export async function voteNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const { filteredInsights = [], previousInsights = [] } = state;

  // Convert previousInsights (VotedInsightType[]) back to ValidatedInsight-like for merging
  const prevAsValidated: ValidatedInsightType[] = previousInsights.flatMap(
    (vi) =>
      vi.sources.map((src) => ({
        kind: vi.kind,
        source: src,
        timeRelevance: vi.timeRelevance,
        regionRelevance: vi.regionRelevance,
        confidence: vi.confidence,
        sourceTrust: vi.sourceTrust,
        timeStamp: new Date(src.timestamp).toISOString(),
        isValid: true,
        extractionReason: "carry-forward from previous phase",
        insightLocation: vi.insightLocation,
      })),
  );

  const allInsights = [
    ...filteredInsights.filter((i) => i.isValid),
    ...prevAsValidated,
  ];

  if (allInsights.length === 0) {
    logger.info("vote-node: no valid insights to vote on", {
      filteredTotal: filteredInsights.length,
      previousTotal: previousInsights.length,
    });
    return {
      messages: [new AIMessage("vote-node: no valid insights to vote on")],
      votedResult: {
        insights: filteredInsights,
        consensus: {},
        needsClarify: false,
        timestamp: Date.now(),
      },
    };
  }

  const grouped = groupInsightsByKind(allInsights);
  const consensusMap: Record<string, VotedInsightType> = {};
  const droppedKinds: DroppedKindInfo[] = [];
  let anyNeedsClarify = false;

  for (const [kind, insightsForKind] of grouped) {
    const options = computeOptions(insightsForKind);
    if (!options.length) continue;

    const best = options[0]!;
    const rejected = options.slice(1).flatMap((o) => o.insights);

    const withReason = (
      insight: ValidatedInsightType,
      reason: string,
    ): ValidatedInsightType => ({
      ...insight,
      rejectionReason: insight.rejectionReason ?? reason,
    });

    // Drop impact/casualities insights where region has zero overlap with user zones
    // (not_a_user_zone = Petah Tikva case — no connection to user's monitored areas)
    const LOCATION_KINDS = new Set(["impact", "casualities"]);
    if (
      LOCATION_KINDS.has(kind) &&
      best.insightLocation === "not_a_user_zone"
    ) {
      // Every source said "not user zone" → skip this insight entirely, but always keep an explicit reason.
      droppedKinds.push({
        kind,
        reason:
          'refutation_found: all candidate insights marked as "not_a_user_zone"',
        candidateCount: insightsForKind.length,
      });
      continue;
    }

    const clarifyNeed = getClarifyNeed(kind, best.avgConfidence);
    if (clarifyNeed === "needs_clarify") anyNeedsClarify = true;

    const carryForwardCount = best.insights.filter(
      (i) => i.extractionReason === "carry-forward from previous phase",
    ).length;
    const freshCount = best.insights.length - carryForwardCount;
    const updateMode =
      freshCount > 0 && carryForwardCount > 0
        ? "refreshed_with_new_evidence"
        : carryForwardCount > 0
        ? "carry_forward_refresh"
        : "new_consensus";

    const rejectedWithReason = rejected.map((ri) => {
      const rejectedConfidence = (ri.confidence ?? 0).toFixed(2);
      const bestConfidence = best.avgConfidence.toFixed(2);
      return withReason(
        ri,
        `not_precise: rejected in favor of higher-confidence consensus (${bestConfidence} > ${rejectedConfidence})`,
      );
    });

    consensusMap[kind] = {
      kind: best.kind,
      sources: best.sources,
      confidence: best.avgConfidence,
      sourceTrust: best.avgSourceTrust,
      timeRelevance: best.avgTimeRelevance,
      regionRelevance: best.avgRegionRelevance,
      reason: `${updateMode}; consensus from ${
        insightsForKind.length
      } source(s), avg confidence ${(best.avgConfidence * 100).toFixed(0)}%`,
      rejectedInsights: rejectedWithReason,
      insightLocation: best.insightLocation,
    };
  }

  const votedResult: VotedResultType = {
    insights: allInsights,
    consensus: consensusMap,
    needsClarify: anyNeedsClarify,
    timestamp: Date.now(),
  };

  return {
    messages: [
      new AIMessage(
        JSON.stringify({
          node: "vote",
          kinds: Object.keys(consensusMap),
          totalInsights: allInsights.length,
          carryForward: prevAsValidated.length,
          droppedKinds,
          needsClarify: anyNeedsClarify,
        }),
      ),
    ],
    votedResult,
  };
}
