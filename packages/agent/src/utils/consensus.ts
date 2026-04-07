/**
 * Deterministic voting / consensus helpers (0 LLM tokens).
 *
 * Merges filteredInsights + previousInsights (carry-forward),
 * picks best consensus per kind by confidence.
 */

import type {
  BaseSourceMessageType,
  InsightLocationType,
  ValidatedInsightType,
  VotedInsightType,
  VotedResultType,
} from "@easyoref/shared";

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

function computeOptions(group: ValidatedInsightType[]): InsightOption[] {
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

export function buildConsensus(
  filteredInsights: ValidatedInsightType[],
  previousInsights: VotedInsightType[],
): VotedResultType {
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
    return {
      insights: filteredInsights,
      consensus: {},
      needsClarify: false,
      timestamp: Date.now(),
    };
  }

  const grouped = groupInsightsByKind(allInsights);
  const consensusMap: Record<string, VotedInsightType> = {};
  const LOCATION_KINDS = new Set(["impact", "casualities"]);

  for (const [kind, insightsForKind] of grouped) {
    const options = computeOptions(insightsForKind);
    if (!options.length) continue;

    const best = options[0]!;
    const rejected = options.slice(1).flatMap((o) => o.insights);

    if (
      LOCATION_KINDS.has(kind) &&
      best.insightLocation === "not_a_user_zone"
    ) {
      continue;
    }

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

    const rejectedWithReason = rejected.map((ri) => ({
      ...ri,
      rejectionReason:
        ri.rejectionReason ??
        `not_precise: rejected in favor of higher-confidence consensus (${best.avgConfidence.toFixed(2)} > ${(ri.confidence ?? 0).toFixed(2)})`,
    }));

    consensusMap[kind] = {
      kind: best.kind,
      sources: best.sources,
      confidence: best.avgConfidence,
      sourceTrust: best.avgSourceTrust,
      timeRelevance: best.avgTimeRelevance,
      regionRelevance: best.avgRegionRelevance,
      reason: `${updateMode}; consensus from ${insightsForKind.length} source(s), avg confidence ${(best.avgConfidence * 100).toFixed(0)}%`,
      rejectedInsights: rejectedWithReason,
      insightLocation: best.insightLocation,
    };
  }

  return {
    insights: allInsights,
    consensus: consensusMap,
    needsClarify: false,
    timestamp: Date.now(),
  };
}
