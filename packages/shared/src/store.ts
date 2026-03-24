/**
 * Session-based alert state store — Redis operations.
 *
 * A "session" spans the lifecycle of one attack event:
 *   early_warning → (optional siren) → resolved → +10 min tail
 *
 * Keys:
 *   session:active        — ActiveSession JSON         TTL 45min
 *   session:posts         — LPUSH list of ChannelPost  TTL 45min
 *   session:ext_cache     — HASH {post_hash → extraction JSON} TTL 45min
 *   alert:{alertId}:meta  — AlertMeta JSON             TTL 20min
 *
 * Only the LATEST alert's Telegram message gets enrichment edits.
 * Posts accumulate across the entire session (shared context).
 */

import { getRedis } from "./redis.js";
import type {
  ActiveSession,
  AlertMeta,
  AlertType,
  ChannelPost,
  EnrichmentData,
  TelegramMessage,
} from "./schemas.js";
import { createEmptyEnrichmentData } from "./schemas.js";

// Re-export types for backward compatibility
export type { ActiveSession, AlertMeta, ChannelPost, TelegramMessage };

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
  early_warning: 60_000, // 60s — channels need time to post; saves tokens
  siren: 45_000, // 45s
  resolved: 150_000, // 150s (2.5 min) — per user requirement: 10 min window, update every 2.5 min
};

/** Initial enrichment delay — first job after alert (channels need time to post) */
export const PHASE_INITIAL_DELAY_MS: Record<AlertType, number> = {
  early_warning: 120_000, // 2 min — wait for launch reports
  siren: 15_000, // 15s
  resolved: 90_000, // 90s — wait for first wave of post-incident reports
};

// ──Alert Meta (per-alert) ─────────────────────────────

export async function saveAlertMeta(meta: AlertMeta): Promise<void> {
  const redis = getRedis();
  await redis.setex(
    `alert:${meta.alertId}:meta`,
    META_TTL_S,
    JSON.stringify(meta),
  );
}

export async function getAlertMeta(
  alertId: string,
): Promise<AlertMeta | undefined> {
  const redis = getRedis();
  const raw = await redis.get(`alert:${alertId}:meta`);
  return raw ? (JSON.parse(raw) as AlertMeta) : undefined;
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

export async function getActiveSession(): Promise<ActiveSession | undefined> {
  const redis = getRedis();
  const raw = await redis.get("session:active");
  return raw ? (JSON.parse(raw) as ActiveSession) : undefined;
}

export async function clearSession(): Promise<void> {
  const redis = getRedis();
  await redis.del(
    "session:active",
    "session:posts",
    "session:enrichment",
    EXT_CACHE_KEY,
    LAST_UPDATE_KEY,
  );
}

export function isPhaseExpired(session: ActiveSession): boolean {
  const elapsed = Date.now() - session.phaseStartTs;
  return elapsed >= PHASE_TIMEOUT_MS[session.phase];
}

// ── Compat shims (used by gramjs-monitor, graph) ───────

export async function getActiveAlert(): Promise<
  | {
      alertId: string;
      alertTs: number;
      alertType: AlertType;
    }
  | undefined
> {
  const s = await getActiveSession();
  if (!s) return undefined;
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
  return raw
    ? (JSON.parse(raw) as EnrichmentData)
    : createEmptyEnrichmentData();
}

// ── Last update timestamp (tracks when last enrichment job ran) ──

const LAST_UPDATE_KEY = "session:last_update_ts";

export async function getLastUpdateTs(): Promise<number> {
  const redis = getRedis();
  const raw = await redis.get(LAST_UPDATE_KEY);
  return raw ? Number(raw) : 0;
}

export async function setLastUpdateTs(ts: number): Promise<void> {
  const redis = getRedis();
  await redis.setex(LAST_UPDATE_KEY, SESSION_TTL_S, String(ts));
}

// ── Extraction cache (post-level dedup between jobs) ───

const EXT_CACHE_KEY = "session:ext_cache";

/**
 * Get cached extraction results for a batch of post hashes.
 * Returns a map: postHash → serialized ValidatedExtraction JSON.
 */
export async function getCachedExtractions(
  postHashes: string[],
): Promise<Map<string, string>> {
  if (postHashes.length === 0) return new Map();
  const redis = getRedis();
  const results = await redis.hmget(EXT_CACHE_KEY, ...postHashes);
  const map = new Map<string, string>();
  postHashes.forEach((hash, i) => {
    if (results[i]) map.set(hash, results[i]!);
  });
  return map;
}

/**
 * Save new extraction results to cache.
 * @param entries - Record of postHash → serialized ValidatedExtraction JSON
 */
export async function saveCachedExtractions(
  entries: Record<string, string>,
): Promise<void> {
  if (Object.keys(entries).length === 0) return;
  const redis = getRedis();
  await redis.hset(EXT_CACHE_KEY, entries);
  await redis.expire(EXT_CACHE_KEY, SESSION_TTL_S);
}
