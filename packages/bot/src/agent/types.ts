/** Shared types for the agent subsystem */

export type AlertType = "early_warning" | "siren" | "resolved";

// ── Channel tracking (pre-graph structure) ─────────────

export interface TrackedMessage {
  timestamp: number;
  text: string;
  url?: string;
  channel: string;
}

export interface ChannelWithUpdates {
  channel: string;
  /** Posts from session start to last enrichment job (already processed) */
  prev_tracked_messages: TrackedMessage[];
  /** Posts since last enrichment job (new, need processing) */
  last_tracked_messages: TrackedMessage[];
}

export interface ChannelTracking {
  track_start_timestamp: number;
  last_update_timestamp: number;
  channels_with_updates: ChannelWithUpdates[];
}

/**
 * Qualitative count descriptor — used when channels report without exact numbers.
 * "none" is only shown if confidence > 0.95 and explicitly stated in source.
 */
export type QualCount =
  | "all" // все
  | "most" // большинство
  | "many" // много
  | "few" // несколько
  | "exists" // есть
  | "none" // нет (strict: only if explicitly stated)
  | "more_than" // >N (with optional qual_num)
  | "less_than"; // <N (with optional qual_num)

// ── Pre-filter (deterministic, zero tokens) ────────────

export interface RelevanceCheck {
  channel: string;
  text: string;
  ts: number;
  /** true if post passed keyword/region pre-filter */
  relevant: boolean;
}

// ── LLM extraction (single call per post) ──────────────

export interface ExtractionResult {
  channel: string;
  /** V1: region relevance (0-1) — does post mention our alert region? */
  region_relevance: number;
  /** V2: source trust (0-1) — factual reporting vs rumors/panic? */
  source_trust: number;
  /** Extracted data */
  country_origin: string | null;
  rocket_count: number | null;
  is_cassette: boolean | null;
  /** Rocket breakdown: intercepted by Iron Dome */
  intercepted: number | null;
  /** Qualitative descriptor when no exact number is stated (null if exact number given) */
  intercepted_qual: QualCount | null;
  intercepted_qual_num: number | null; // reference number for more_than/less_than
  /** Rocket breakdown: fell in sea/empty area */
  sea_impact: number | null;
  sea_impact_qual: QualCount | null;
  sea_impact_qual_num: number | null;
  /** Rocket breakdown: hit open/populated ground */
  open_area_impact: number | null;
  open_area_impact_qual: QualCount | null;
  open_area_impact_qual_num: number | null;
  hits_confirmed: number | null;
  /** Region where impact occurred (in UI language) */
  hit_location?: string | null;
  /** Type of impact */
  hit_type?: "direct" | "shrapnel" | null;
  /** Impact detail: where/how (e.g. "open area", "building", "sea", "no damage"). In UI language. */
  hit_detail?: string | null;
  /** Casualties reported (injured/killed) — primarily resolved phase */
  casualties: number | null;
  injuries: number | null;
  eta_refined_minutes: number | null;
  /** Verbatim per-region rocket breakdown (e.g. "2 center, 3 north") */
  rocket_detail: string | null;
  /** V3: tone — "calm"|"neutral"|"alarmist" */
  tone: "calm" | "neutral" | "alarmist";
  /** Overall extraction confidence (0-1) */
  confidence: number;
  /**
   * Time relevance (0-1) — does this post discuss the CURRENT attack?
   * LLM sets: 0 = clearly about a previous/different event, 1 = current event.
   * Post-filter rejects posts with time_relevance < 0.5.
   */
  time_relevance: number;
}

// ── Post-filter (deterministic, zero tokens) ───────────

export interface ValidatedExtraction extends ExtractionResult {
  /** Passed all three validators? */
  valid: boolean;
  /** Reason if rejected */
  reject_reason?: string;
  /** Link to original Telegram post (from ChannelPost.messageUrl) */
  messageUrl?: string;
}

// ── Cited source entry ─────────────────────────────────

export interface CitedSource {
  /** 1-based citation index */
  index: number;
  channel: string;
  messageUrl: string | null;
}

// ── Voted consensus ────────────────────────────────────

export interface VotedResult {
  /** ETA in minutes (highest-confidence source) */
  eta_refined_minutes: number | null;
  /** Citation indices that provided ETA */
  eta_citations: number[];

  /** Unique origin countries with per-country citation indices */
  country_origins: Array<{ name: string; citations: number[] }> | null;

  /** Rocket count range across sources (min == max → exact) */
  rocket_count_min: number | null;
  rocket_count_max: number | null;
  rocket_citations: number[];
  /** Avg weighted confidence of sources reporting rocket count (for uncertainty marker) */
  rocket_confidence: number;
  /** Verbatim per-region rocket breakdown if sources split by region */
  rocket_detail: string | null;

  is_cassette: boolean | null;
  /** Avg weighted confidence of sources confirming cassette munitions */
  is_cassette_confidence: number;

  /** Rocket breakdown (median values; null if no sources reported) */
  intercepted: number | null;
  intercepted_qual: QualCount | null;
  intercepted_qual_num: number | null;
  /** Avg weighted confidence of sources reporting intercepted count */
  intercepted_confidence: number;
  sea_impact: number | null;
  sea_impact_qual: QualCount | null;
  sea_impact_qual_num: number | null;
  sea_confidence: number;
  open_area_impact: number | null;
  open_area_impact_qual: QualCount | null;
  open_area_impact_qual_num: number | null;
  open_area_confidence: number;

  hits_confirmed: number | null;
  /** Citation indices that provided hits data */
  hits_citations: number[];
  /** Avg weighted confidence of sources reporting confirmed hits */
  hits_confidence: number;
  /** Region where impact occurred (in UI language, from highest-confidence source) */
  hit_location: string | null;
  /** Type of impact: direct or shrapnel/debris */
  hit_type: "direct" | "shrapnel" | null;
  /** Impact detail: where/how (e.g. "на открытой местности", "здание", "в море") */
  hit_detail: string | null;
  /** Sources explicitly confirm NO impacts ("прилетов нет") */
  no_impacts: boolean;
  no_impacts_citations: number[];
  /** Citation indices for intercepted data */
  intercepted_citations: number[];

  casualties: number | null;
  casualties_citations: number[];
  casualties_confidence: number;

  injuries: number | null;
  injuries_citations: number[];
  injuries_confidence: number;

  confidence: number;
  sources_count: number;
  /** All valid sources, ordered by citation index */
  citedSources: CitedSource[];
}

/**
 * Cross-phase enrichment data persisted in Redis.
 * Each phase writes its findings; the next phase reads and carries forward.
 * This is the "single track" — results flow: early → siren → resolved.
 *
 * Inline citations are stored as arrays of {url, channel} for rendering
 * as [[1]](url), [[2]](url) inline after each data point.
 */
export interface InlineCite {
  url: string;
  channel: string;
}

export interface EnrichmentData {
  /** Origin country (from early_warning or siren) */
  origin: string | null;
  originCites: InlineCite[];
  /** ETA absolute time string (e.g. "~17:42") */
  etaAbsolute: string | null;
  etaCites: InlineCite[];
  /** Rocket count display string (e.g. "~5–7") */
  rocketCount: string | null;
  rocketCites: InlineCite[];
  /** Is cassette munitions */
  isCassette: boolean | null;
  /** Interception data display string (e.g. "3", "большинство") */
  intercepted: string | null;
  interceptedCites: InlineCite[];
  /** Sea impact display string */
  seaImpact: string | null;
  /** Open area impact display string */
  openAreaImpact: string | null;
  /** Confirmed hits on structures */
  hitsConfirmed: string | null;
  hitsCites: InlineCite[];
  /** Region where impact occurred (in UI language) */
  hitLocation: string | null;
  /** Type of impact: "direct" | "shrapnel" */
  hitType: string | null;
  /** Impact detail: where/how (e.g. "на открытой местности", "здание") */
  hitDetail: string | null;
  /** Explicitly confirmed no impacts */
  noImpacts: boolean;
  noImpactsCites: InlineCite[];
  /** Verbatim per-region rocket breakdown */
  rocketDetail: string | null;
  /** Casualties / injuries (from resolved) */
  casualties: string | null;
  casualtiesCites: InlineCite[];
  injuries: string | null;
  injuriesCites: InlineCite[];
  /** Time early_warning was received (for siren "Раннее: было в HH:MM") */
  earlyWarningTime: string | null;
  /** Hash of last enriched text to detect "message not modified" before sending */
  lastEditHash: string | null;
}

/** Empty enrichment data template */
export function emptyEnrichmentData(): EnrichmentData {
  return {
    origin: null,
    originCites: [],
    etaAbsolute: null,
    etaCites: [],
    rocketCount: null,
    rocketCites: [],
    isCassette: null,
    intercepted: null,
    interceptedCites: [],
    seaImpact: null,
    openAreaImpact: null,
    hitsConfirmed: null,
    hitsCites: [],
    hitLocation: null,
    hitType: null,
    hitDetail: null,
    noImpacts: false,
    noImpactsCites: [],
    rocketDetail: null,
    casualties: null,
    casualtiesCites: [],
    injuries: null,
    injuriesCites: [],
    earlyWarningTime: null,
    lastEditHash: null,
  };
}
