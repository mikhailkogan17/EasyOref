/**
 * EasyOref — Centralized Configuration
 *
 * Primary: config.yaml (searched in cwd, /app, /etc/easyoref)
 * YAML-only SSOT — only EASYOREF_CONFIG env var (path to YAML file) is read from environment.
 *
 * See config.yaml.example for all available options.
 */

import yaml from "js-yaml";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type AlertTypeConfig,
  type GifModeType as GifMode,
} from "./schemas.js";

// ── Types ────────────────────────────────────────────────

const VALID_GIF_MODES: GifMode[] = ["funny_cats", "none"];

const ALL_ALERT_TYPES: AlertTypeConfig[] = ["early", "red_alert", "resolved"];

interface ShelterYaml {
  max_distance_km?: number;
  max_results?: number;
  source?: "static" | "overpass";
  api_url?: string;
}

/** Raw YAML schema */
interface ConfigYaml {
  city_ids?: number[];
  alert_types?: AlertTypeConfig[];
  gif_mode?: string;
  emoji_override?: Partial<Record<AlertTypeConfig, string>>;
  title_override?: Partial<Record<AlertTypeConfig, string>>;
  description_override?: Partial<Record<AlertTypeConfig, string>>;
  observability?: {
    betterstack_token?: string;
  };
  telegram?: {
    bot_token?: string;
  };
  health_port?: number;
  poll_interval_ms?: number;
  data_dir?: string;
  oref_api_url?: string;
  oref_history_url?: string;
  /**
   * Redis key namespace prefix for multi-instance deployments.
   * All Redis keys (store + BullMQ queue) are scoped to this prefix.
   * Example: "ru" → keys like "ru:session:active", queue "ru:enrich-alert"
   * Defaults to "" (no prefix — backward-compatible single-instance behaviour).
   */
  redis_prefix?: string;
  /** Telegram user IDs with admin access (for /grant, /revoke, /users commands) */
  admin_chat_ids?: number[];
  ai?: ConfigYamlAi;
  shelter?: ShelterYaml;
}

interface PhaseTimingYaml {
  early_warning?: number;
  red_alert?: number;
  resolved?: number;
}

interface ConfigYamlAi {
  enabled?: boolean;
  openrouter_api_key?: string;
  openrouter_filter_model?: string;
  openrouter_filter_fallback_model?: string;
  openrouter_extract_model?: string;
  openrouter_extract_fallback_model?: string;
  redis_url?: string;
  socks5_proxy?: string;
  enrich_delay_ms?: number;
  window_minutes?: number;
  timeout_minutes?: number;
  /** Max enrichment runs per alert session (default 3) */
  max_enrich_runs?: number;
  /** Per-phase initial delay before first enrichment (ms) */
  phase_initial_delay_ms?: PhaseTimingYaml;
  /** Per-phase interval between enrichment runs (ms) */
  phase_enrich_delay_ms?: PhaseTimingYaml;
  /** Per-phase max duration before auto-expire (ms) */
  phase_timeout_ms?: PhaseTimingYaml;
  mtproto?: {
    api_id?: number;
    api_hash?: string;
    session_string?: string;
  };
  channels?: string[];
  /** Map monitored area prefix → human-readable region label */
  area_labels?: Record<string, string>;
  /** LangSmith tracing */
  langsmith_api_key?: string;
  langsmith_project?: string;
  /** Q&A rate limit per user per minute (default 5) */
  qa_rate_limit_per_min?: number;
  /** Model to use for Q&A answers (defaults to filter model) */
  qa_model?: string;
  /** Run canary (synthetic test alert) on startup to verify pipeline health */
  canary?: boolean;
}

// ── YAML Loader ──────────────────────────────────────────

/** Config dir in user home — ~/.easyoref/ */
export const CONFIG_DIR = join(homedir(), ".easyoref");
export const HOME_CONFIG_PATH = join(CONFIG_DIR, "config.yaml");

const CONFIG_SEARCH_PATHS = [
  HOME_CONFIG_PATH,
  "config.yaml",
  "config.yml",
  "/app/config.yaml",
  "/etc/easyoref/config.yaml",
];

function findConfigFile(): string | null {
  const envPath = process.env.EASYOREF_CONFIG;
  if (envPath && existsSync(envPath)) return envPath;
  for (const p of CONFIG_SEARCH_PATHS) {
    const abs = resolve(p);
    if (existsSync(abs)) return abs;
  }
  return null;
}

function loadYaml(): ConfigYaml {
  const path = findConfigFile();
  if (path) {
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = yaml.load(raw) as ConfigYaml;
      // eslint-disable-next-line no-console
      console.log(`[config] Loaded from ${path}`);
      return parsed ?? {};
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[config] Failed to parse ${path}:`, err);
    }
  }
  return {};
}

// ── Helpers ──────────────────────────────────────────────

function readSecret(envKey: string, secretPaths: string[]): string {
  for (const p of secretPaths) {
    if (existsSync(p)) return readFileSync(p, "utf-8").trim();
  }
  return process.env[envKey] ?? "";
}

function parseGifMode(raw: string): GifMode {
  const lower = raw.toLowerCase() as GifMode;
  return VALID_GIF_MODES.includes(lower) ? lower : "none";
}

function parseAlertTypes(raw?: AlertTypeConfig[]): AlertTypeConfig[] {
  if (!raw || !Array.isArray(raw)) return ALL_ALERT_TYPES;
  return raw.filter((t) => ALL_ALERT_TYPES.includes(t));
}

// ── Build Config ─────────────────────────────────────────

const yml = loadYaml();

export const config = {
  /** Telegram bot token */
  botToken:
    yml.telegram?.bot_token ??
    readSecret("BOT_TOKEN", ["/run/secrets/bot_token", "secrets/bot_token"]),

  /** City IDs to monitor (Hebrew area names resolved via initTranslations) */
  cityIds: yml.city_ids ?? [],

  /** Which alert types to send */
  alertTypes: parseAlertTypes(yml.alert_types),

  /**
   * Redis key namespace prefix for multi-instance deployments.
   * Applied as ioredis `keyPrefix` on all connections (store + agent).
   * BullMQ queue name is also scoped: `{redisPrefix}:enrich-alert` (or plain when empty).
   * Env var: REDIS_PREFIX
   */
  redisPrefix: yml.redis_prefix ?? "",

  /** Telegram user IDs with admin access for /grant, /revoke, /users commands */
  adminChatIds: yml.admin_chat_ids ?? [],

  /** Emoji overrides per alert type */
  emojiOverride: yml.emoji_override ?? {},

  /** Title overrides per alert type */
  titleOverride: yml.title_override ?? {},

  /** Description overrides per alert type */
  descriptionOverride: yml.description_override ?? {},

  /** Oref API polling interval (ms) */
  pollIntervalMs: yml.poll_interval_ms ?? 2000,

  /** Health endpoint port */
  healthPort: yml.health_port ?? 3100,

  /** Oref API URL */
  orefApiUrl:
    yml.oref_api_url ??
    "https://www.oref.org.il/WarningMessages/alert/alerts.json",

  /** Oref alert history URL (base, without date params) */
  orefHistoryUrl: yml.oref_history_url ?? "",

  /** Better Stack Logtail token */
  logtailToken: yml.observability?.betterstack_token ?? "",

  /** GIF mode */
  gifMode: parseGifMode(yml.gif_mode ?? "none"),

  /** Path for persistent data */
  dataDir: yml.data_dir ?? join(CONFIG_DIR, "data"),

  /** Civil defense shelter search config (YAML key: `shelter`) */
  shelter: {
    maxDistanceKm: yml.shelter?.max_distance_km ?? 2,
    maxResults: yml.shelter?.max_results ?? 5,
    source: yml.shelter?.source ?? ("overpass" as "static" | "overpass"),
    apiUrl: yml.shelter?.api_url ?? "",
  },

  /** AI enrichment config (YAML key: `ai`) */
  agent: (() => {
    const ai = yml.ai;
    return {
      enabled: ai?.enabled ?? false,
      apiKey: ai?.openrouter_api_key ?? "",
      filterModel: ai?.openrouter_filter_model ?? "openai/gpt-oss-120b",
      filterFallbackModel:
        ai?.openrouter_filter_fallback_model ?? "openai/gpt-oss-120b:free",
      extractModel: ai?.openrouter_extract_model ?? "openai/gpt-oss-120b",
      extractFallbackModel:
        ai?.openrouter_extract_fallback_model ?? "openai/gpt-oss-120b:free",
      redisUrl: ai?.redis_url ?? "redis://localhost:6379",
      socks5Proxy: ai?.socks5_proxy ?? "",
      enrichDelayMs: ai?.enrich_delay_ms ?? 20_000,
      windowMinutes: ai?.window_minutes ?? 2,
      timeoutMinutes: ai?.timeout_minutes ?? 15,
      /** Max enrichment runs per alert session */
      maxEnrichRuns: ai?.max_enrich_runs ?? 3,
      /** Per-phase initial delay before first enrichment (ms) */
      phaseInitialDelayMs: {
        early_warning: ai?.phase_initial_delay_ms?.early_warning ?? 120_000,
        red_alert: ai?.phase_initial_delay_ms?.red_alert ?? 15_000,
        resolved: ai?.phase_initial_delay_ms?.resolved ?? 90_000,
      },
      /** Per-phase interval between enrichment runs (ms) */
      phaseEnrichDelayMs: {
        early_warning: ai?.phase_enrich_delay_ms?.early_warning ?? 60_000,
        red_alert: ai?.phase_enrich_delay_ms?.red_alert ?? 45_000,
        resolved: ai?.phase_enrich_delay_ms?.resolved ?? 150_000,
      },
      /** Per-phase max duration before auto-expire (ms) */
      phaseTimeoutMs: {
        early_warning: ai?.phase_timeout_ms?.early_warning ?? 30 * 60 * 1000,
        red_alert: ai?.phase_timeout_ms?.red_alert ?? 15 * 60 * 1000,
        resolved: ai?.phase_timeout_ms?.resolved ?? 10 * 60 * 1000,
      },
      mtproto: {
        apiId: ai?.mtproto?.api_id ?? 0,
        apiHash: ai?.mtproto?.api_hash ?? "",
        sessionString: ai?.mtproto?.session_string ?? "",
      },
      channels: ai?.channels ?? [],
      areaLabels: ai?.area_labels ?? {},
      /** LangSmith tracing */
      langsmithApiKey: ai?.langsmith_api_key ?? "",
      langsmithProject: ai?.langsmith_project ?? "",
      /** Q&A rate limit per user per minute */
      qaRateLimitPerMin: ai?.qa_rate_limit_per_min ?? 5,
      /** Model for Q&A answers */
      qaModel:
        ai?.qa_model ?? ai?.openrouter_filter_model ?? "openai/gpt-oss-120b",
      /** Run canary (synthetic test alert) on startup */
      canary: ai?.canary ?? false,
    };
  })(),
};

/**
 * Set LANGSMITH_* env vars so the LangChain SDK auto-enables tracing.
 * Call once at startup (before any LangChain import triggers).
 */
export function initLangSmithTracing(): void {
  const key = config.agent.langsmithApiKey;
  const project = config.agent.langsmithProject;
  if (!key) return;
  process.env.LANGSMITH_API_KEY = key;
  process.env.LANGSMITH_TRACING = "true";
  if (project) process.env.LANGSMITH_PROJECT = project;
}

/** Exported for testing */
export {
  loadYaml as _loadYaml,
  parseAlertTypes as _parseAlertTypes,
  type ConfigYaml,
};
