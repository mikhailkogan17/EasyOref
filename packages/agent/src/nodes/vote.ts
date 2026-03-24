/**
 * Vote Node — consensus voting, deterministic, 0 tokens.
 *
 * Aggregates extraction results from multiple sources into a single
 * voted consensus using median, majority, and weighted confidence.
 */

import * as logger from "@easyoref/monitoring";
import type {
  CitedSource,
  QualCount,
  ValidatedExtraction,
  VotedResult,
} from "@easyoref/shared";
import type { AgentStateType } from "../graph.js";

function weightedConfidence(
  sources: Array<{ sourceTrust: number; confidence: number }>,
): number {
  if (sources.length === 0) return 0;
  return (
    sources.reduce(
      (accumulator, extraction) =>
        accumulator + extraction.sourceTrust * extraction.confidence,
      0,
    ) / sources.length
  );
}

function modeQualification(
  sources: Array<Record<string, unknown>>,
  key: string,
): QualCount | undefined {
  const values = sources
    .map((extraction) => extraction[key] as QualCount | undefined)
    .filter((value): value is QualCount => value !== undefined);
  if (values.length === 0) return undefined;
  const frequency = new Map<QualCount, number>();
  for (const value of values)
    frequency.set(value, (frequency.get(value) ?? 0) + 1);
  return [...frequency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function medianQualificationNumber(
  sources: Array<Record<string, unknown>>,
  key: string,
): number | undefined {
  const values = sources
    .map((extraction) => extraction[key] as number | undefined)
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b);
  return values.length > 0 ? values[Math.floor(values.length / 2)] : undefined;
}

function aggregateVote(
  extractions: ValidatedExtraction[],
  alertId: string,
): VotedResult | undefined {
  const valid = extractions.filter((extraction) => extraction.valid);

  if (valid.length === 0) return undefined;

  const indexed = valid.map((extraction, index) => ({
    ...extraction,
    citationIndex: index + 1,
  }));

  const citedSources: CitedSource[] = indexed.map((extraction) => ({
    index: extraction.citationIndex,
    channel: extraction.channel,
    ...(extraction.messageUrl && { messageUrl: extraction.messageUrl }),
  }));

  const etaSources = indexed
    .filter((extraction) => extraction.etaRefinedMinutes !== undefined)
    .sort((a, b) => b.confidence - a.confidence);
  const bestEtaSource = etaSources[0];

  const countryMap = new Map<
    string,
    { canonical: string; citations: number[] }
  >();
  for (const extraction of indexed) {
    if (extraction.countryOrigin) {
      const key = extraction.countryOrigin.toLowerCase();
      const entry = countryMap.get(key);
      if (entry) {
        entry.citations.push(extraction.citationIndex);
      } else {
        countryMap.set(key, {
          canonical: extraction.countryOrigin,
          citations: [extraction.citationIndex],
        });
      }
    }
  }
  const countryOrigins =
    countryMap.size > 0
      ? Array.from(countryMap.values()).map(({ canonical, citations }) => ({
          name: canonical,
          citations,
        }))
      : undefined;

  const rocketSources = indexed.filter(
    (extraction) => extraction.rocketCount !== undefined,
  );
  const rocketValues = rocketSources.map(
    (extraction) => extraction.rocketCount as number,
  );
  const rocketCountMin =
    rocketValues.length > 0 ? Math.min(...rocketValues) : undefined;
  const rocketCountMax =
    rocketValues.length > 0 ? Math.max(...rocketValues) : undefined;
  const rocketCitations = rocketSources.map(
    (extraction) => extraction.citationIndex,
  );
  const rocketConfidence = weightedConfidence(rocketSources);

  const detailSources = indexed
    .filter((extraction) => extraction.rocketDetail)
    .sort((a, b) => b.confidence - a.confidence);
  const rocketDetail = detailSources[0]?.rocketDetail;

  const cassetteSources = indexed.filter(
    (extraction) => extraction.isCassette !== undefined,
  );
  const cassetteValues = cassetteSources.map(
    (extraction) => extraction.isCassette as boolean,
  );
  const isCassette =
    cassetteValues.length > 0
      ? cassetteValues.filter(Boolean).length > cassetteValues.length / 2
      : undefined;
  const cassetteConfidence = weightedConfidence(cassetteSources);

  const interceptedSources = indexed.filter(
    (extraction) => extraction.intercepted !== undefined,
  );
  const interceptedQualSources = indexed.filter(
    (extraction) => extraction.interceptedQual !== undefined,
  );
  const interceptedValues = interceptedSources
    .map((extraction) => extraction.intercepted as number)
    .sort((a, b) => a - b);
  const intercepted =
    interceptedValues.length > 0
      ? interceptedValues[Math.floor(interceptedValues.length / 2)]
      : undefined;
  const interceptedQual =
    intercepted === undefined
      ? modeQualification(interceptedQualSources, "interceptedQual")
      : undefined;
  const interceptedQualNumber = interceptedQual
    ? medianQualificationNumber(interceptedQualSources, "interceptedQual_num")
    : undefined;
  const interceptedConfidence = weightedConfidence(
    interceptedSources.length > 0 ? interceptedSources : interceptedQualSources,
  );

  const seaSources = indexed.filter(
    (extraction) => extraction.seaImpact !== undefined,
  );
  const seaQualSources = indexed.filter(
    (extraction) => extraction.seaImpactQual !== undefined,
  );
  const seaValues = seaSources
    .map((extraction) => extraction.seaImpact as number)
    .sort((a, b) => a - b);
  const seaImpact =
    seaValues.length > 0
      ? seaValues[Math.floor(seaValues.length / 2)]
      : undefined;
  const seaImpactQual =
    seaImpact === undefined
      ? modeQualification(seaQualSources, "seaImpactQual")
      : undefined;
  const seaImpactQualNumber = seaImpactQual
    ? medianQualificationNumber(seaQualSources, "seaImpactQual_num")
    : undefined;
  const seaConfidence = weightedConfidence(
    seaSources.length > 0 ? seaSources : seaQualSources,
  );

  const openSources = indexed.filter(
    (extraction) => extraction.openAreaImpact !== undefined,
  );
  const openQualSources = indexed.filter(
    (extraction) => extraction.openAreaImpactQual !== undefined,
  );
  const openValues = openSources
    .map((extraction) => extraction.openAreaImpact as number)
    .sort((a, b) => a - b);
  const openAreaImpact =
    openValues.length > 0
      ? openValues[Math.floor(openValues.length / 2)]
      : undefined;
  const openAreaImpactQual =
    openAreaImpact === undefined
      ? modeQualification(openQualSources, "openAreaImpactQual")
      : undefined;
  const openAreaImpactQualNumber = openAreaImpactQual
    ? medianQualificationNumber(openQualSources, "openAreaImpactQual_num")
    : undefined;
  const openAreaConfidence = weightedConfidence(
    openSources.length > 0 ? openSources : openQualSources,
  );

  const allHitsSources = indexed.filter(
    (extraction) => extraction.hitsConfirmed !== undefined,
  );
  const hitsValues = allHitsSources
    .map((extraction) => extraction.hitsConfirmed as number)
    .sort((a, b) => a - b);
  const hitsConfirmed =
    hitsValues.length > 0
      ? hitsValues[Math.floor(hitsValues.length / 2)]
      : undefined;
  const positiveHitsSources = allHitsSources.filter(
    (extraction) => (extraction.hitsConfirmed as number) > 0,
  );
  const hitsCitations =
    positiveHitsSources.length > 0
      ? positiveHitsSources.map((extraction) => extraction.citationIndex)
      : allHitsSources.map((extraction) => extraction.citationIndex);
  const hitsConfidence = weightedConfidence(allHitsSources);

  const hitsWithLocation = positiveHitsSources
    .filter((extraction) => extraction.hitLocation)
    .sort((a, b) => b.confidence - a.confidence);
  const hitLocation = hitsWithLocation[0]?.hitLocation;
  const hitType = hitsWithLocation[0]?.hitType;

  const hitsWithDetail = positiveHitsSources
    .filter((extraction) => extraction.hitDetail)
    .sort((a, b) => b.confidence - a.confidence);
  const hitDetail = hitsWithDetail[0]?.hitDetail;

  const noImpactSources = allHitsSources.filter(
    (extraction) => (extraction.hitsConfirmed as number) === 0,
  );
  const noImpacts = noImpactSources.length > 0 && hitsConfirmed === 0;
  const noImpactsCitations = noImpactSources.map(
    (extraction) => extraction.citationIndex,
  );

  const casualtySources = indexed.filter(
    (extraction) => extraction.casualties && extraction.casualties > 0,
  );
  const casualtyValues = casualtySources
    .map((extraction) => extraction.casualties as number)
    .sort((a, b) => a - b);
  const casualties =
    casualtyValues.length > 0
      ? casualtyValues[Math.floor(casualtyValues.length / 2)]
      : undefined;
  const casualtiesCitations = casualtySources.map(
    (extraction) => extraction.citationIndex,
  );
  const casualtiesConfidence = weightedConfidence(casualtySources);

  const injurySources = indexed.filter(
    (extraction) =>
      extraction.injuries !== undefined && (extraction.injuries as number) > 0,
  );
  const injuryValues = injurySources
    .map((extraction) => extraction.injuries as number)
    .sort((a, b) => a - b);
  const injuries =
    injuryValues.length > 0
      ? injuryValues[Math.floor(injuryValues.length / 2)]
      : undefined;
  const injuriesCitations = injurySources.map(
    (extraction) => extraction.citationIndex,
  );
  const injuriesConfidence = weightedConfidence(injurySources);

  const injuryCauseValues = injurySources
    .map((extraction) => extraction.injuriesCause)
    .filter(
      (value): value is "rocket" | "rushing_to_shelter" => value !== undefined,
    );
  const rocketCauseCount = injuryCauseValues.filter(
    (value) => value === "rocket",
  ).length;
  const shelterCauseCount = injuryCauseValues.filter(
    (value) => value === "rushing_to_shelter",
  ).length;
  const injuriesCause =
    injuryCauseValues.length === 0
      ? undefined
      : rocketCauseCount >= shelterCauseCount
      ? "rocket"
      : "rushing_to_shelter";

  const totalWeight = indexed.reduce(
    (accumulator, extraction) =>
      accumulator + extraction.sourceTrust * extraction.confidence,
    0,
  );
  const weightedConfidenceValue = totalWeight / indexed.length;

  const voted: VotedResult = {
    etaRefinedMinutes: bestEtaSource?.etaRefinedMinutes,
    etaCitations: bestEtaSource ? [bestEtaSource.citationIndex] : [],
    countryOrigins: countryOrigins ?? [],
    rocketCountMin: rocketCountMin,
    rocketCountMax: rocketCountMax,
    rocketCitations: rocketCitations,
    rocketConfidence: rocketConfidence,
    rocketDetail: rocketDetail,
    isCassette: isCassette,
    isCassetteConfidence: cassetteConfidence,
    intercepted,
    interceptedQual: interceptedQual,
    interceptedConfidence: interceptedConfidence,
    seaImpact: seaImpact,
    seaImpactQual: seaImpactQual,
    seaConfidence: seaConfidence,
    openAreaImpact: openAreaImpact,
    openAreaImpactQual: openAreaImpactQual,
    openAreaConfidence: openAreaConfidence,
    hitsConfirmed: hitsConfirmed,
    hitsCitations: hitsCitations,
    hitsConfidence: hitsConfidence,
    hitLocation: hitLocation,
    hitType: hitType,
    hitDetail: hitDetail,
    noImpacts: noImpacts,
    noImpactsCitations: noImpactsCitations,
    interceptedCitations: interceptedSources.map(
      (extraction) => extraction.citationIndex,
    ),
    casualties,
    casualtiesCitations: casualtiesCitations,
    casualtiesConfidence: casualtiesConfidence,
    injuries,
    injuriesCause: injuriesCause,
    injuriesCitations: injuriesCitations,
    injuriesConfidence: injuriesConfidence,
    confidence: Math.round(weightedConfidenceValue * 100) / 100,
    sourcesCount: indexed.length,
    citedSources,
  };

  logger.info("Agent: voted", { alertId, voted });
  return voted;
}

export const voteNode = (state: AgentStateType): Partial<AgentStateType> => {
  return { votedResult: aggregateVote(state.extractions, state.alertId) };
};

export const vote = aggregateVote;
