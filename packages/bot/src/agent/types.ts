/** Shared types for the agent subsystem */

export type AlertType = "early_warning" | "siren" | "resolved";

/**
 * Qualitative count descriptor — used when channels report without exact numbers.
 * "none" is only shown if confidence > 0.95 and explicitly stated in source.
 */
export type QualCount =
  | "all"        // все
  | "most"       // большинство
  | "many"       // много
  | "few"        // несколько
  | "exists"     // есть
  | "none"       // нет (strict: only if explicitly stated)
  | "more_than"  // >N (with optional qual_num)
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
  eta_refined_minutes: number | null;
  /** V3: tone — "calm"|"neutral"|"alarmist" */
  tone: "calm" | "neutral" | "alarmist";
  /** Overall extraction confidence (0-1) */
  confidence: number;
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

  confidence: number;
  sources_count: number;
  /** All valid sources, ordered by citation index */
  citedSources: CitedSource[];
}
