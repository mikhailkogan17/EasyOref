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

// ── Types ────────────────────────────────────────────────

export type AlertTypeConfig = "early" | "siren" | "resolved";
export type GifMode = "funny_cats" | "none";

const VALID_GIF_MODES: GifMode[] = ["funny_cats", "none"];

const ALL_ALERT_TYPES: AlertTypeConfig[] = ["early", "siren", "resolved"];

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
    chat_id?: string;
  };
  health_port?: number;
  poll_interval_ms?: number;
  data_dir?: string;
  oref_api_url?: string;
  ai?: ConfigYamlAi;
}

interface ConfigYamlAi {
  enabled?: boolean;
  openrouter_api_key?: string;
  openrouter_model?: string;
  redis_url?: string;
  socks5_proxy?: string;
  enrich_delay_ms?: number;
  confidence_threshold?: number;
  window_minutes?: number;
  timeout_minutes?: number;
  mtproto?: {
    api_id?: number;
    api_hash?: string;
    session_string?: string;
  };
  channels?: string[];
  /** Map monitored area prefix → human-readable region label */
  area_labels?: Record<string, string>;
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

  /** Telegram chat ID */
  chatId: yml.telegram?.chat_id ?? process.env.CHAT_ID ?? "",

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
    const raw = (yml.language ?? process.env.LANGUAGE ?? "ru").toLowerCase();
    return isValidLanguage(raw) ? raw : "ru";
  })(),

  /** Emoji overrides per alert type */
  emojiOverride: yml.emoji_override ?? {},

  /** Title overrides per alert type */
  titleOverride: yml.title_override ?? {},

  /** Description overrides per alert type */
  descriptionOverride: yml.description_override ?? {},

  /** Oref API polling interval (ms) */
  pollIntervalMs:
    yml.poll_interval_ms ?? Number(process.env.OREF_POLL_INTERVAL_MS ?? "2000"),

  /** Health endpoint port */
  healthPort: yml.health_port ?? Number(process.env.HEALTH_PORT ?? "3100"),

  /** Oref API URL */
  orefApiUrl:
    yml.oref_api_url ??
    process.env.OREF_API_URL ??
    "https://www.oref.org.il/WarningMessages/alert/alerts.json",

  /** Better Stack Logtail token */
  logtailToken:
    yml.observability?.betterstack_token ?? process.env.LOGTAIL_TOKEN ?? "",

  /** GIF mode */
  gifMode: parseGifMode(yml.gif_mode ?? process.env.GIF_MODE ?? "none"),

  /** Path for persistent data */
  dataDir: yml.data_dir ?? process.env.DATA_DIR ?? join(CONFIG_DIR, "data"),

  /** AI enrichment config (YAML key: `ai`) */
  agent: (() => {
    const ai = yml.ai;
    return {
      enabled: ai?.enabled ?? false,
      apiKey: ai?.openrouter_api_key ?? process.env.OPENROUTER_API_KEY ?? "",
      model: ai?.openrouter_model ?? "google/gemini-3-flash-preview",
      redisUrl:
        ai?.redis_url ?? process.env.REDIS_URL ?? "redis://localhost:6379",
      socks5Proxy: ai?.socks5_proxy ?? process.env.SOCKS5_PROXY ?? "",
      enrichDelayMs: ai?.enrich_delay_ms ?? 20_000,
      confidenceThreshold: ai?.confidence_threshold ?? 0.7,
      windowMinutes: ai?.window_minutes ?? 2,
      timeoutMinutes: ai?.timeout_minutes ?? 15,
      mtproto: {
        apiId: ai?.mtproto?.api_id ?? Number(process.env.TG_API_ID ?? "0"),
        apiHash: ai?.mtproto?.api_hash ?? process.env.TG_API_HASH ?? "",
        sessionString:
          ai?.mtproto?.session_string ?? process.env.TG_SESSION ?? "",
      },
      channels: ai?.channels ?? [],
      areaLabels: ai?.area_labels ?? {},
    };
  })(),
};

/** Exported for testing */
export {
  loadYaml as _loadYaml,
  parseAlertTypes as _parseAlertTypes,
  type ConfigYaml,
};
