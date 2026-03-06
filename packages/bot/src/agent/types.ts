/** Shared types for the agent subsystem */

export type AlertType = "early_warning" | "siren" | "resolved";

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

  is_cassette: boolean | null;
  hits_confirmed: number | null;
  /** Citation indices that provided hits data */
  hits_citations: number[];

  confidence: number;
  sources_count: number;
  /** All valid sources, ordered by citation index */
  citedSources: CitedSource[];
}
