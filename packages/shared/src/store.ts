/**
 * Session-based alert state store — Redis operations.
 *
 * A "session" spans the lifecycle of one attack event:
 *   early_warning → (optional red_alert) → resolved → +10 min tail
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

import { config } from "./config.js";
import { getRedis } from "./redis.js";
import type {
  ActiveSessionType,
  AlertMetaType,
  AlertType,
  ChannelPostType,
  EnrichmentType,
  UserConfigType,
  VotedInsightType,
} from "./schemas.js";
import { createEmptyEnrichment } from "./schemas.js";

// Internal aliases for use within this file
type AlertMeta = AlertMetaType;
type ChannelPost = ChannelPostType;
type ActiveSession = ActiveSessionType;
type Enrichment = EnrichmentType;
type VotedInsight = VotedInsightType;
type UserConfig = UserConfigType;

//  version for migration handling
export const SCHEMA_VERSION = "2.0.0";
const SCHEMA_VERSION_KEY = "schema:version";

let schemaVersionChecked = false;

export async function ensureVersion(): Promise<void> {
  if (schemaVersionChecked) return;
  schemaVersionChecked = true;

  const redis = getRedis();
  const stored = await redis.get(SCHEMA_VERSION_KEY);

  if (stored !== SCHEMA_VERSION) {
    // Scoped flush: delete only keys belonging to this instance.
    // ioredis keyPrefix is transparent to the app — keys are stored in Redis
    // as "{prefix}:{key}" but read/written without the prefix here.
    // We must SCAN the raw Redis keyspace using the actual stored pattern.
    const rawPattern = config.redisPrefix
      ? `${config.redisPrefix}:*`
      : "easyoref:*"; // no-prefix instances use a literal namespace guard

    let cursor = "0";
    do {
      const [nextCursor, keys] = (await redis.call(
        "SCAN",
        cursor,
        "MATCH",
        rawPattern,
        "COUNT",
        "100",
      )) as [string, string[]];
      cursor = nextCursor;
      if (keys.length > 0) {
        // Keys from SCAN are raw (include prefix) — strip prefix before DEL
        // because ioredis will re-add it.
        const stripped = config.redisPrefix
          ? keys.map((k) => k.slice(`${config.redisPrefix}:`.length))
          : keys;
        await redis.del(...stripped);
      }
    } while (cursor !== "0");

    await redis.set(SCHEMA_VERSION_KEY, SCHEMA_VERSION);
  }
}

const META_TTL_S = 20 * 60; // 20 minutes
const SESSION_TTL_S = 45 * 60; // 45 min worst case

// ── Session phase timeouts ─────────────────────────────

/** Max duration (ms) for each phase before auto-expire */
export const PHASE_TIMEOUT_MS: Record<AlertType, number> = {
  early_warning: 30 * 60 * 1000, // 30 min
  red_alert: 15 * 60 * 1000, // 15 min
  resolved: 10 * 60 * 1000, // 10 min tail
};

/** Enrichment interval (ms) per phase */
export const PHASE_ENRICH_DELAY_MS: Record<AlertType, number> = {
  early_warning: 60_000, // 60s — channels need time to post; saves tokens
  red_alert: 45_000, // 45s
  resolved: 150_000, // 150s (2.5 min) — per user requirement: 10 min window, update every 2.5 min
};

/** Initial enrichment delay — first job after alert (channels need time to post) */
export const PHASE_INITIAL_DELAY_MS: Record<AlertType, number> = {
  early_warning: 120_000, // 2 min — wait for launch reports
  red_alert: 15_000, // 15s
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
    VOTED_INSIGHTS_KEY,
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

export async function saveEnrichment(data: Enrichment): Promise<void> {
  const redis = getRedis();
  await redis.setex("session:enrichment", SESSION_TTL_S, JSON.stringify(data));
}

export async function getEnrichment(): Promise<Enrichment> {
  const redis = getRedis();
  const raw = await redis.get("session:enrichment");
  return raw ? (JSON.parse(raw) as Enrichment) : createEmptyEnrichment();
}

// ── Voted insights (cross-phase carry-forward) ────────

const VOTED_INSIGHTS_KEY = "session:voted_insights";

/**
 * Persist consensus VotedInsight[] from synthesize-node so the next
 * enrichment job can carry them forward as previousInsights.
 */
export async function saveVotedInsights(
  insights: VotedInsight[],
): Promise<void> {
  const redis = getRedis();
  await redis.setex(
    VOTED_INSIGHTS_KEY,
    SESSION_TTL_S,
    JSON.stringify(insights),
  );
}

/**
 * Load previously saved VotedInsight[] for carry-forward into the next graph run.
 * Returns empty array if nothing stored.
 */
export async function getVotedInsights(): Promise<VotedInsight[]> {
  const redis = getRedis();
  const raw = await redis.get(VOTED_INSIGHTS_KEY);
  return raw ? (JSON.parse(raw) as VotedInsight[]) : [];
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

// ── User store (multi-user, persistent) ────────────────

const USER_KEY_PREFIX = "user:";
const AREA_INDEX_PREFIX = "area:";

/**
 * Save a UserConfig to Redis. Maintains area reverse index.
 * Redis key: `user:{chatId}` (JSON, no TTL — persistent).
 * Area index: `area:{areaName}` → SET of chatIds.
 */
export async function saveUser(user: UserConfig): Promise<void> {
  const redis = getRedis();
  const key = `${USER_KEY_PREFIX}${user.chatId}`;

  // Remove old area index entries if user already exists
  const existingRaw = await redis.get(key);
  if (existingRaw) {
    const existing = JSON.parse(existingRaw) as UserConfig;
    for (const area of existing.areas) {
      await redis.srem(`${AREA_INDEX_PREFIX}${area}`, user.chatId);
    }
  }

  await redis.set(key, JSON.stringify(user));

  // Add new area index entries
  for (const area of user.areas) {
    await redis.sadd(`${AREA_INDEX_PREFIX}${area}`, user.chatId);
  }
}

/**
 * Get a UserConfig by chatId. Returns undefined if not found.
 */
export async function getUser(chatId: string): Promise<UserConfig | undefined> {
  const redis = getRedis();
  const raw = await redis.get(`${USER_KEY_PREFIX}${chatId}`);
  return raw ? (JSON.parse(raw) as UserConfig) : undefined;
}

/**
 * Get all registered users.
 */
export async function getAllUsers(): Promise<UserConfig[]> {
  const redis = getRedis();
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, batch] = (await redis.call(
      "SCAN",
      cursor,
      "MATCH",
      `${USER_KEY_PREFIX}*`,
      "COUNT",
      "100",
    )) as [string, string[]];
    cursor = nextCursor;
    // Strip ioredis keyPrefix from SCAN results before GET
    const prefix = config.redisPrefix ? `${config.redisPrefix}:` : "";
    for (const rawKey of batch) {
      keys.push(prefix ? rawKey.slice(prefix.length) : rawKey);
    }
  } while (cursor !== "0");

  if (keys.length === 0) return [];
  const pipeline = redis.pipeline();
  for (const k of keys) pipeline.get(k);
  const results = await pipeline.exec();
  const users: UserConfig[] = [];
  if (results) {
    for (const [err, val] of results) {
      if (!err && typeof val === "string") {
        users.push(JSON.parse(val) as UserConfig);
      }
    }
  }
  return users;
}

/**
 * Delete a user and clean up area index.
 */
export async function deleteUser(chatId: string): Promise<void> {
  const redis = getRedis();
  const key = `${USER_KEY_PREFIX}${chatId}`;
  const raw = await redis.get(key);
  if (raw) {
    const user = JSON.parse(raw) as UserConfig;
    for (const area of user.areas) {
      await redis.srem(`${AREA_INDEX_PREFIX}${area}`, chatId);
    }
  }
  await redis.del(key);
}

/**
 * Get all chatIds subscribed to a given area.
 * Uses the `area:{name}` SET reverse index for O(1) lookup.
 */
export async function getUsersByArea(area: string): Promise<string[]> {
  const redis = getRedis();
  return redis.smembers(`${AREA_INDEX_PREFIX}${area}`);
}
