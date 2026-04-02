/**
 * EasyOref — Centralized Configuration
 *
 * Primary: config.yaml (searched in cwd, /app, /etc/easyoref)
 * Fallback: environment variables + Docker secrets (for backward compat)
 *
 * See config.yaml.example for all available options.
 */

import yaml from "js-yaml";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isValidLanguage, type Language } from "./i18n.js";
import {
  type AlertTypeConfig,
  type GifModeType as GifMode,
} from "./schemas.js";

// ── Types ────────────────────────────────────────────────

const VALID_GIF_MODES: GifMode[] = ["funny_cats", "none"];

const ALL_ALERT_TYPES: AlertTypeConfig[] = ["early", "red_alert", "resolved"];

/** Raw YAML schema */
interface ConfigYaml {
  alert_types?: AlertTypeConfig[];
  city_ids?: number[];
  language?: string;
  gif_mode?: string;
  emoji_override?: Partial<Record<AlertTypeConfig, string>>;
  title_override?: Partial<Record<AlertTypeConfig, string>>;
  description_override?: Partial<Record<AlertTypeConfig, string>>;
  observability?: {
    betterstack_token?: string;
  };
  telegram?: {
    bot_token?: string;
    chat_id?: string | string[];
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
  ai?: ConfigYamlAi;
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
  /** Enable MCP tool calling for low-confidence clarification */
  mcp_tools?: boolean;
  /** Number of recent posts to fetch per channel during clarify (1-4) */
  clarify_fetch_count?: number;
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

const parsedChatIds: string[] = (() => {
  const raw = yml.telegram?.chat_id ?? "";
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
})();

export const config = {
  /** Telegram bot token */
  botToken: yml.telegram?.bot_token ?? readSecret("BOT_TOKEN", ["/run/secrets/bot_token", "secrets/bot_token"]),

  /** All Telegram chat IDs to broadcast to */
  chatIds: parsedChatIds,

  /** Primary Telegram chat ID (first in the list) */
  chatId: parsedChatIds[0] ?? "",

  /** City IDs to monitor (resolved to Hebrew names at startup via cities.json) */
  cityIds: yml.city_ids ?? [],

  /**
   * Hebrew area names — legacy fallback for AREAS env var.
   * Populated at startup from cityIds OR from AREAS env if no cityIds.
   */
  areas: [] as string[],

  /** Which alert types to send */
  alertTypes: parseAlertTypes(yml.alert_types),

  /** Message language */
  language: ((): Language => {
    const raw = (yml.language ?? "ru").toLowerCase();
    return isValidLanguage(raw) ? raw : "ru";
  })(),

  /**
   * Redis key namespace prefix for multi-instance deployments.
   * Applied as ioredis `keyPrefix` on all connections (store + agent).
   * BullMQ queue name is also scoped: `{redisPrefix}:enrich-alert` (or plain when empty).
   * Env var: REDIS_PREFIX
   */
  redisPrefix: yml.redis_prefix ?? "",

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

  /** AI enrichment config (YAML key: `ai`) */
  agent: (() => {
    const ai = yml.ai;
    return {
      enabled: ai?.enabled ?? false,
      apiKey: ai?.openrouter_api_key ?? "",
      filterModel: ai?.openrouter_filter_model ?? "openai/gpt-oss-120b",
      filterFallbackModel:
        ai?.openrouter_filter_fallback_model ?? "openai/gpt-oss-120b:free",
      extractModel:
        ai?.openrouter_extract_model ?? "openai/gpt-oss-120b",
      extractFallbackModel:
        ai?.openrouter_extract_fallback_model ?? "openai/gpt-oss-120b:free",
      redisUrl: ai?.redis_url ?? "redis://localhost:6379",
      socks5Proxy: ai?.socks5_proxy ?? "",
      enrichDelayMs: ai?.enrich_delay_ms ?? 20_000,
      windowMinutes: ai?.window_minutes ?? 2,
      timeoutMinutes: ai?.timeout_minutes ?? 15,
      mtproto: {
        apiId: ai?.mtproto?.api_id ?? 0,
        apiHash: ai?.mtproto?.api_hash ?? "",
        sessionString: ai?.mtproto?.session_string ?? "",
      },
      channels: ai?.channels ?? [],
      areaLabels: ai?.area_labels ?? {},
      /** Enable MCP tool calling — deterministic fan-out on low confidence */
      mcpTools: ai?.mcp_tools ?? false,
      /** Posts per channel to fetch during clarify (1-4, default 3) */
      clarifyFetchCount: Math.min(4, Math.max(1, ai?.clarify_fetch_count ?? 3)),
      /** LangSmith tracing */
      langsmithApiKey: ai?.langsmith_api_key ?? "",
      langsmithProject: ai?.langsmith_project ?? "",
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
