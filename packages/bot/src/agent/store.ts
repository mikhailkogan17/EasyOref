/**
 * Session-based alert state store — Redis operations.
 *
 * A "session" spans the lifecycle of one attack event:
 *   early_warning → (optional siren) → resolved → +10 min tail
 *
 * Keys:
 *   session:active        — ActiveSession JSON         TTL 45min
 *   session:posts         — LPUSH list of ChannelPost  TTL 45min
 *   alert:{alertId}:meta  — AlertMeta JSON             TTL 20min
 *
 * Only the LATEST alert's Telegram message gets enrichment edits.
 * Posts accumulate across the entire session (shared context).
 */

import { getRedis } from "./redis.js";
import type { AlertType, EnrichmentData } from "./types.js";
import { emptyEnrichmentData } from "./types.js";

const META_TTL_S = 20 * 60; // 20 minutes
const SESSION_TTL_S = 45 * 60; // 45 min worst case

// ── Session phase timeouts ─────────────────────────────

/** Max duration (ms) for each phase before auto-expire */
export const PHASE_TIMEOUT_MS: Record<AlertType, number> = {
  early_warning: 30 * 60 * 1000, // 30 min
  siren: 15 * 60 * 1000, // 15 min
  resolved: 10 * 60 * 1000, // 10 min tail
};

/** Enrichment interval (ms) per phase */
export const PHASE_ENRICH_DELAY_MS: Record<AlertType, number> = {
  early_warning: 20_000, // 20s
  siren: 20_000, // 20s
  resolved: 60_000, // 60s — detailed intel comes slower
};

/** Initial enrichment delay — first job after alert (channels need time to post) */
export const PHASE_INITIAL_DELAY_MS: Record<AlertType, number> = {
  early_warning: 120_000, // 2 min — wait for launch reports
  siren: 15_000, // 15s
  resolved: 60_000, // 60s
};

// ── Types ──────────────────────────────────────────────

export interface AlertMeta {
  alertId: string;
  messageId: number;
  chatId: string;
  isCaption: boolean;
  alertTs: number;
  alertType: AlertType;
  alertAreas: string[];
  currentText: string;
}

export interface ChannelPost {
  channel: string;
  text: string;
  ts: number;
  messageUrl?: string;
}

export interface ActiveSession {
  /** First alertId that started this session */
  sessionId: string;
  sessionStartTs: number;
  /** Current phase */
  phase: AlertType;
  phaseStartTs: number;
  /** Latest alert being enriched */
  latestAlertId: string;
  latestMessageId: number;
  latestAlertTs: number;
  chatId: string;
  isCaption: boolean;
  currentText: string;
  alertAreas: string[];
}

// ── Alert Meta (per-alert) ─────────────────────────────

export async function saveAlertMeta(meta: AlertMeta): Promise<void> {
  const redis = getRedis();
  await redis.setex(
    `alert:${meta.alertId}:meta`,
    META_TTL_S,
    JSON.stringify(meta),
  );
}

export async function getAlertMeta(alertId: string): Promise<AlertMeta | null> {
  const redis = getRedis();
  const raw = await redis.get(`alert:${alertId}:meta`);
  return raw ? (JSON.parse(raw) as AlertMeta) : null;
}

// ── Session posts (shared across entire session) ───────

export async function pushSessionPost(post: ChannelPost): Promise<void> {
  const redis = getRedis();
  await redis.lpush("session:posts", JSON.stringify(post));
  await redis.expire("session:posts", SESSION_TTL_S);
}

export async function getSessionPosts(): Promise<ChannelPost[]> {
  const redis = getRedis();
  const items = await redis.lrange("session:posts", 0, -1);
  return items.map((i: string) => JSON.parse(i) as ChannelPost);
}

// ── Active session ─────────────────────────────────────

export async function setActiveSession(session: ActiveSession): Promise<void> {
  const redis = getRedis();
  await redis.setex("session:active", SESSION_TTL_S, JSON.stringify(session));
}

export async function getActiveSession(): Promise<ActiveSession | null> {
  const redis = getRedis();
  const raw = await redis.get("session:active");
  return raw ? (JSON.parse(raw) as ActiveSession) : null;
}

export async function clearSession(): Promise<void> {
  const redis = getRedis();
  await redis.del("session:active", "session:posts", "session:enrichment");
}

export function isPhaseExpired(session: ActiveSession): boolean {
  const elapsed = Date.now() - session.phaseStartTs;
  return elapsed >= PHASE_TIMEOUT_MS[session.phase];
}

// ── Compat shims (used by gramjs-monitor, graph) ───────

export async function getActiveAlert(): Promise<{
  alertId: string;
  alertTs: number;
  alertType: AlertType;
} | null> {
  const s = await getActiveSession();
  if (!s) return null;
  return {
    alertId: s.latestAlertId,
    alertTs: s.latestAlertTs,
    alertType: s.phase,
  };
}

export async function pushChannelPost(
  _alertId: string,
  post: ChannelPost,
): Promise<void> {
  await pushSessionPost(post);
}

export async function getChannelPosts(
  _alertId: string,
): Promise<ChannelPost[]> {
  return getSessionPosts();
}

// ── Enrichment data (cross-phase persistence) ──────────

export async function saveEnrichmentData(data: EnrichmentData): Promise<void> {
  const redis = getRedis();
  await redis.setex("session:enrichment", SESSION_TTL_S, JSON.stringify(data));
}

export async function getEnrichmentData(): Promise<EnrichmentData> {
  const redis = getRedis();
  const raw = await redis.get("session:enrichment");
  return raw ? (JSON.parse(raw) as EnrichmentData) : emptyEnrichmentData();
}
