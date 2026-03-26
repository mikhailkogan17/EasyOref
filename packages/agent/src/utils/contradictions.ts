/**
 * Contradiction detection for ValidatedInsight[].
 * Used by clarify-node to generate the user prompt for the LLM.
 */

import type { ValidatedInsightType } from "@easyoref/shared";

export function describeContradictions(insights: ValidatedInsightType[]): string {
  const issues: string[] = [];
  const valid = insights.filter((i) => i.isValid);

  // Group by kind
  const grouped = new Map<string, ValidatedInsightType[]>();
  for (const insight of valid) {
    const k = insight.kind.kind;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k)!.push(insight);
  }

  // Multiple country origins
  const countryInsights = grouped.get("country_origins") ?? [];
  if (countryInsights.length > 0) {
    const countries = new Set<string>();
    for (const i of countryInsights) {
      if (i.kind.kind === "country_origins") {
        (i.kind.value as Set<string>).forEach((c) => countries.add(c));
      }
    }
    if (countries.size > 1) {
      issues.push(`Multiple origin countries reported: ${Array.from(countries).join(", ")}`);
    }
  }

  // Wide rocket count range
  const rocketInsights = grouped.get("rocket_count") ?? [];
  if (rocketInsights.length > 1) {
    const values = rocketInsights
      .filter((i) => i.kind.kind === "rocket_count" && i.kind.value.type === "exact")
      .map((i) => (i.kind.kind === "rocket_count" ? (i.kind.value as { type: "exact"; value: number }).value : 0));
    if (values.length > 1) {
      const min = Math.min(...values);
      const max = Math.max(...values);
      if (max - min > 3) issues.push(`Wide rocket count range: ${min}–${max}`);
    }
  }

  // Low-confidence insights
  const lowConf = valid.filter((i) => (i.confidence ?? 0) < 0.5);
  if (lowConf.length > 0) {
    issues.push(`${lowConf.length} insight(s) have low confidence (< 0.5)`);
  }

  issues.push(`Total valid insights: ${valid.length}`);
  issues.push(`Insight kinds: ${Array.from(grouped.keys()).join(", ")}`);

  return issues.join("\n");
}
