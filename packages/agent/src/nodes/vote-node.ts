/**
 * Vote Node — consensus voting, deterministic, 0 tokens.
 *
 * Aggregates extraction results from multiple sources into a single
 * voted consensus using median, majority, and weighted confidence.
 */

import * as logger from "@easyoref/monitoring";
import type { AgentStateType } from "../graph.js";
import type {
  CitedSource,
  QualCount,
  ValidatedExtraction,
  VotedResult,
} from "@easyoref/shared";

function weightedConfidence(
  sources: Array<{ source_trust: number; confidence: number }>,
): number {
  if (sources.length === 0) return 0;
  return (
    sources.reduce(
      (accumulator, extraction) =>
        accumulator + extraction.source_trust * extraction.confidence,
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
  return values.length > 0
    ? values[Math.floor(values.length / 2)]
    : undefined;
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
    .filter((extraction) => extraction.eta_refined_minutes !== undefined)
    .sort((a, b) => b.confidence - a.confidence);
  const bestEtaSource = etaSources[0];

  const countryMap = new Map<string, { canonical: string; citations: number[] }>();
  for (const extraction of indexed) {
    if (extraction.country_origin) {
      const key = extraction.country_origin.toLowerCase();
      const entry = countryMap.get(key);
      if (entry) {
        entry.citations.push(extraction.citationIndex);
      } else {
        countryMap.set(key, {
          canonical: extraction.country_origin,
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
    (extraction) => extraction.rocket_count !== undefined,
  );
  const rocketValues = rocketSources.map(
    (extraction) => extraction.rocket_count as number,
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
    .filter((extraction) => extraction.rocket_detail)
    .sort((a, b) => b.confidence - a.confidence);
  const rocketDetail = detailSources[0]?.rocket_detail;

  const cassetteSources = indexed.filter(
    (extraction) => extraction.is_cassette !== undefined,
  );
  const cassetteValues = cassetteSources.map(
    (extraction) => extraction.is_cassette as boolean,
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
    (extraction) => extraction.intercepted_qual !== undefined,
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
      ? modeQualification(interceptedQualSources, "intercepted_qual")
      : undefined;
  const interceptedQualNumber = interceptedQual
    ? medianQualificationNumber(interceptedQualSources, "intercepted_qual_num")
    : undefined;
  const interceptedConfidence = weightedConfidence(
    interceptedSources.length > 0 ? interceptedSources : interceptedQualSources,
  );

  const seaSources = indexed.filter((extraction) => extraction.sea_impact !== undefined);
  const seaQualSources = indexed.filter(
    (extraction) => extraction.sea_impact_qual !== undefined,
  );
  const seaValues = seaSources
    .map((extraction) => extraction.sea_impact as number)
    .sort((a, b) => a - b);
  const seaImpact =
    seaValues.length > 0
      ? seaValues[Math.floor(seaValues.length / 2)]
      : undefined;
  const seaImpactQual =
    seaImpact === undefined
      ? modeQualification(seaQualSources, "sea_impact_qual")
      : undefined;
  const seaImpactQualNumber = seaImpactQual
    ? medianQualificationNumber(seaQualSources, "sea_impact_qual_num")
    : undefined;
  const seaConfidence = weightedConfidence(
    seaSources.length > 0 ? seaSources : seaQualSources,
  );

  const openSources = indexed.filter(
    (extraction) => extraction.open_area_impact !== undefined,
  );
  const openQualSources = indexed.filter(
    (extraction) => extraction.open_area_impact_qual !== undefined,
  );
  const openValues = openSources
    .map((extraction) => extraction.open_area_impact as number)
    .sort((a, b) => a - b);
  const openAreaImpact =
    openValues.length > 0
      ? openValues[Math.floor(openValues.length / 2)]
      : undefined;
  const openAreaImpactQual =
    openAreaImpact === undefined
      ? modeQualification(openQualSources, "open_area_impact_qual")
      : undefined;
  const openAreaImpactQualNumber = openAreaImpactQual
    ? medianQualificationNumber(openQualSources, "open_area_impact_qual_num")
    : undefined;
  const openAreaConfidence = weightedConfidence(
    openSources.length > 0 ? openSources : openQualSources,
  );

  const allHitsSources = indexed.filter(
    (extraction) => extraction.hits_confirmed !== undefined,
  );
  const hitsValues = allHitsSources
    .map((extraction) => extraction.hits_confirmed as number)
    .sort((a, b) => a - b);
  const hitsConfirmed =
    hitsValues.length > 0
      ? hitsValues[Math.floor(hitsValues.length / 2)]
      : undefined;
  const positiveHitsSources = allHitsSources.filter(
    (extraction) => (extraction.hits_confirmed as number) > 0,
  );
  const hitsCitations =
    positiveHitsSources.length > 0
      ? positiveHitsSources.map((extraction) => extraction.citationIndex)
      : allHitsSources.map((extraction) => extraction.citationIndex);
  const hitsConfidence = weightedConfidence(allHitsSources);

  const hitsWithLocation = positiveHitsSources
    .filter((extraction) => extraction.hit_location)
    .sort((a, b) => b.confidence - a.confidence);
  const hitLocation = hitsWithLocation[0]?.hit_location;
  const hitType = hitsWithLocation[0]?.hit_type;

  const hitsWithDetail = positiveHitsSources
    .filter((extraction) => extraction.hit_detail)
    .sort((a, b) => b.confidence - a.confidence);
  const hitDetail = hitsWithDetail[0]?.hit_detail;

  const noImpactSources = allHitsSources.filter(
    (extraction) => (extraction.hits_confirmed as number) === 0,
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
    .map((extraction) => extraction.injuries_cause)
    .filter(
      (value): value is "rocket" | "rushing_to_shelter" =>
        value !== undefined,
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
      accumulator + extraction.source_trust * extraction.confidence,
    0,
  );
  const weightedConfidenceValue = totalWeight / indexed.length;

  const voted: VotedResult = {
    eta_refined_minutes: bestEtaSource?.eta_refined_minutes,
    eta_citations: bestEtaSource ? [bestEtaSource.citationIndex] : [],
    country_origins: countryOrigins ?? [],
    rocket_count_min: rocketCountMin,
    rocket_count_max: rocketCountMax,
    rocket_citations: rocketCitations,
    rocket_confidence: rocketConfidence,
    rocket_detail: rocketDetail,
    is_cassette: isCassette,
    is_cassette_confidence: cassetteConfidence,
    intercepted,
    intercepted_qual: interceptedQual,
    intercepted_confidence: interceptedConfidence,
    sea_impact: seaImpact,
    sea_impact_qual: seaImpactQual,
    sea_confidence: seaConfidence,
    open_area_impact: openAreaImpact,
    open_area_impact_qual: openAreaImpactQual,
    open_area_confidence: openAreaConfidence,
    hits_confirmed: hitsConfirmed,
    hits_citations: hitsCitations,
    hits_confidence: hitsConfidence,
    hit_location: hitLocation,
    hit_type: hitType,
    hit_detail: hitDetail,
    no_impacts: noImpacts,
    no_impacts_citations: noImpactsCitations,
    intercepted_citations: interceptedSources.map(
      (extraction) => extraction.citationIndex,
    ),
    casualties,
    casualties_citations: casualtiesCitations,
    casualties_confidence: casualtiesConfidence,
    injuries,
    injuries_cause: injuriesCause,
    injuries_citations: injuriesCitations,
    injuries_confidence: injuriesConfidence,
    confidence: Math.round(weightedConfidenceValue * 100) / 100,
    sources_count: indexed.length,
    citedSources,
  };

  logger.info("Agent: voted", { alertId, voted });
  return voted;
}

export const voteNode = (
  state: AgentStateType,
): Partial<AgentStateType> => {
  return { votedResult: aggregateVote(state.extractions, state.alertId) };
};

export const vote = aggregateVote;
