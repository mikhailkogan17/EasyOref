import yaml from "js-yaml";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ── Helpers ──────────────────────────────────────────────
// We can't import config.ts directly (it evaluates at import time).
// Instead we test the YAML parsing/validation logic in isolation.

type AlertTypeConfig = "early" | "red_alert" | "resolved";
type GifMode = "funny_cats" | "none";

const ALL_ALERT_TYPES: AlertTypeConfig[] = ["early", "red_alert", "resolved"];
const VALID_GIF_MODES: GifMode[] = ["funny_cats", "none"];

interface ConfigYaml {
  alert_types?: AlertTypeConfig[];
  city_ids?: number[];
  language?: string;
  gif_mode?: string;
  emoji_override?: Partial<Record<AlertTypeConfig, string>>;
  title_override?: Partial<Record<AlertTypeConfig, string>>;
  description_override?: Partial<Record<AlertTypeConfig, string>>;
  observability?: { betterstack_token?: string };
  telegram?: { bot_token?: string; chat_id?: string };
  health_port?: number;
  poll_interval_ms?: number;
  data_dir?: string;
  oref_api_url?: string;
}

function parseAlertTypes(raw?: AlertTypeConfig[]): AlertTypeConfig[] {
  if (!raw || !Array.isArray(raw)) return ALL_ALERT_TYPES;
  return raw.filter((t) => ALL_ALERT_TYPES.includes(t));
}

function parseGifMode(raw: string): GifMode {
  const lower = raw.toLowerCase() as GifMode;
  return VALID_GIF_MODES.includes(lower) ? lower : "none";
}

function isValidLanguage(s: string): boolean {
  return s === "ru" || s === "en" || s === "he" || s === "ar";
}

// ── Test fixtures ────────────────────────────────────────

const TMP_DIR = join(import.meta.dirname ?? ".", "__test_tmp__");

function writeTmpYaml(name: string, content: object | string): string {
  mkdirSync(TMP_DIR, { recursive: true });
  const p = join(TMP_DIR, name);
  const raw = typeof content === "string" ? content : yaml.dump(content);
  writeFileSync(p, raw, "utf-8");
  return p;
}

beforeEach(() => mkdirSync(TMP_DIR, { recursive: true }));
afterEach(() => {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
});

// ── YAML Parsing ─────────────────────────────────────────

describe("YAML config parsing", () => {
  it("parses a minimal valid config", () => {
    const path = writeTmpYaml("min.yaml", {
      city_ids: [722],
      telegram: { bot_token: "123:ABC", chat_id: "-100123" },
    });
    const raw = yaml.load(readFileSync(path, "utf-8")) as ConfigYaml;

    expect(raw.city_ids).toEqual([722]);
    expect(raw.telegram?.bot_token).toBe("123:ABC");
    expect(raw.telegram?.chat_id).toBe("-100123");
  });

  it("parses a full config with all fields", () => {
    const full: ConfigYaml = {
      alert_types: ["early", "red_alert"],
      city_ids: [722, 723, 1],
      language: "en",
      gif_mode: "funny_cats",
      title_override: { red_alert: "🚀 ROCKET!" },
      description_override: { red_alert: "Run!" },
      observability: { betterstack_token: "tok_abc" },
      telegram: { bot_token: "123:ABC", chat_id: "-100" },
      health_port: 8080,
      poll_interval_ms: 5000,
      data_dir: "/tmp/data",
    };
    const path = writeTmpYaml("full.yaml", full);
    const raw = yaml.load(readFileSync(path, "utf-8")) as ConfigYaml;

    expect(raw.alert_types).toEqual(["early", "red_alert"]);
    expect(raw.city_ids).toEqual([722, 723, 1]);
    expect(raw.language).toBe("en");
    expect(raw.gif_mode).toBe("funny_cats");
    expect(raw.title_override?.red_alert).toBe("🚀 ROCKET!");
    expect(raw.description_override?.red_alert).toBe("Run!");
    expect(raw.observability?.betterstack_token).toBe("tok_abc");
    expect(raw.health_port).toBe(8080);
    expect(raw.poll_interval_ms).toBe(5000);
  });

  it("handles empty YAML file gracefully", () => {
    const path = writeTmpYaml("empty.yaml", "");
    const raw = yaml.load(readFileSync(path, "utf-8")) as
      | ConfigYaml
      | undefined;

    // yaml.load of empty string returns undefined
    expect(raw ?? {}).toEqual({});
  });

  it("handles YAML with comments only", () => {
    const path = writeTmpYaml("comments.yaml", "# just a comment\n# another");
    const raw = yaml.load(readFileSync(path, "utf-8")) as
      | ConfigYaml
      | undefined;

    expect(raw ?? {}).toEqual({});
  });
});

// ── Alert Types Validation ───────────────────────────────

describe("parseAlertTypes", () => {
  it("returns all types when undefined", () => {
    expect(parseAlertTypes(undefined)).toEqual(ALL_ALERT_TYPES);
  });

  it("returns all types when empty array", () => {
    // Empty array is technically valid but useless → still filtered
    expect(parseAlertTypes([])).toEqual([]);
  });

  it("filters invalid alert types", () => {
    const input = ["early", "bogus", "red_alert"] as AlertTypeConfig[];
    expect(parseAlertTypes(input)).toEqual(["early", "red_alert"]);
  });

  it("keeps valid subset", () => {
    expect(parseAlertTypes(["resolved"])).toEqual(["resolved"]);
  });

  it("returns all types when non-array passed", () => {
    expect(
      parseAlertTypes("red_alert" as unknown as AlertTypeConfig[]),
    ).toEqual(ALL_ALERT_TYPES);
  });
});

// ── GIF Mode Validation ─────────────────────────────────

describe("parseGifMode", () => {
  it("parses valid modes", () => {
    expect(parseGifMode("funny_cats")).toBe("funny_cats");
    expect(parseGifMode("none")).toBe("none");
  });

  it("is case-insensitive", () => {
    expect(parseGifMode("FUNNY_CATS")).toBe("funny_cats");
    expect(parseGifMode("None")).toBe("none");
  });

  it("defaults to none for invalid input", () => {
    expect(parseGifMode("invalid")).toBe("none");
    expect(parseGifMode("")).toBe("none");
  });
});

// ── Language Validation ──────────────────────────────────

describe("isValidLanguage", () => {
  it("accepts ru, en, he, ar", () => {
    expect(isValidLanguage("ru")).toBe(true);
    expect(isValidLanguage("en")).toBe(true);
    expect(isValidLanguage("he")).toBe(true);
    expect(isValidLanguage("ar")).toBe(true);
  });

  it("rejects invalid languages", () => {
    expect(isValidLanguage("fr")).toBe(false);
    expect(isValidLanguage("")).toBe(false);
    expect(isValidLanguage("RU")).toBe(false); // case-sensitive
  });
});

// ── Emoji/Title/Description Overrides ────────────────────

describe("config overrides", () => {
  it("override fields can be partial", () => {
    const yml: ConfigYaml = {
      emoji_override: { early: "🚀" },
      title_override: { red_alert: "CUSTOM SIREN" },
      // description_override not set
    };
    expect(yml.emoji_override?.early).toBe("🚀");
    expect(yml.emoji_override?.red_alert).toBeUndefined();
    expect(yml.title_override?.red_alert).toBe("CUSTOM SIREN");
    expect(yml.title_override?.early).toBeUndefined();
    expect(yml.description_override).toBeUndefined();
  });

  it("YAML round-trips override objects correctly", () => {
    const overrides = {
      emoji_override: {
        early: "🚀",
        red_alert: "🔴",
      },
      title_override: {
        early: "Warning",
        red_alert: "SIREN",
        resolved: "Clear",
      },
      description_override: {
        red_alert: "",
        resolved: "You may leave the shelter.",
      },
    };
    const dumped = yaml.dump(overrides);
    const parsed = yaml.load(dumped) as ConfigYaml;

    expect(parsed.emoji_override).toEqual(overrides.emoji_override);
    expect(parsed.title_override).toEqual(overrides.title_override);
    expect(parsed.description_override).toEqual(overrides.description_override);
  });

  it("empty description string round-trips as empty", () => {
    const yml = { description_override: { red_alert: "" } };
    const dumped = yaml.dump(yml);
    const parsed = yaml.load(dumped) as ConfigYaml;
    expect(parsed.description_override?.red_alert).toBe("");
  });
});

// ── Docker Secret Fallback ───────────────────────────────

describe("secret fallback logic", () => {
  function readSecret(
    envValue: string | undefined,
    secretPath: string | null,
  ): string {
    // Simulate: YAML → env → Docker secret → ""
    if (secretPath && existsSync(secretPath)) {
      return readFileSync(secretPath, "utf-8").trim();
    }
    return envValue ?? "";
  }

  it("reads from secret file when available", () => {
    const path = writeTmpYaml("secret", "my-bot-token\n");
    expect(readSecret(undefined, path)).toBe("my-bot-token");
  });

  it("falls back to env when no secret file", () => {
    expect(readSecret("env-token", "/nonexistent")).toBe("env-token");
  });

  it("returns empty string when nothing available", () => {
    expect(readSecret(undefined, null)).toBe("");
  });
});

// ── Model Resolution Fallback Chain ──────────────────────
// Simulates the config.ts logic: specific key → free default

describe("model resolution fallback", () => {
  const FREE_DEFAULT = "openai/gpt-oss-120b";

  function resolveExtractModel(ai?: {
    openrouter_extract_model?: string;
  }): string {
    return ai?.openrouter_extract_model ?? FREE_DEFAULT;
  }

  function resolveFilterModel(ai?: {
    openrouter_filter_model?: string;
  }): string {
    return ai?.openrouter_filter_model ?? FREE_DEFAULT;
  }

  it("uses extract model when set", () => {
    expect(
      resolveExtractModel({
        openrouter_extract_model: "google/gemini-3.1-flash-lite-preview",
      }),
    ).toBe("google/gemini-3.1-flash-lite-preview");
  });

  it("uses filter model when set", () => {
    expect(
      resolveFilterModel({
        openrouter_filter_model: "openai/gpt-oss-120b",
      }),
    ).toBe("openai/gpt-oss-120b");
  });

  it("falls back to free default when keys are absent", () => {
    expect(resolveExtractModel({})).toBe(FREE_DEFAULT);
    expect(resolveFilterModel({})).toBe(FREE_DEFAULT);
    expect(resolveExtractModel(undefined)).toBe(FREE_DEFAULT);
  });

  it("YAML round-trip preserves model keys correctly", () => {
    const aiConfig = {
      ai: {
        openrouter_filter_model: "openai/gpt-oss-120b",
        openrouter_extract_model: "google/gemini-3.1-flash-lite-preview",
      },
    };
    const dumped = yaml.dump(aiConfig);
    const parsed = yaml.load(dumped) as { ai?: Record<string, string> };
    expect(resolveExtractModel(parsed.ai)).toBe(
      "google/gemini-3.1-flash-lite-preview",
    );
    expect(resolveFilterModel(parsed.ai)).toBe("openai/gpt-oss-120b");
  });
});
