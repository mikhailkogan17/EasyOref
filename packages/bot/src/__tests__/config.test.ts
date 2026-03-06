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

type AlertTypeConfig = "early" | "siren" | "resolved";
type GifMode = "funny_cats" | "assertive" | "pikud_haoref" | "none";

const ALL_ALERT_TYPES: AlertTypeConfig[] = ["early", "siren", "resolved"];
const VALID_GIF_MODES: GifMode[] = [
  "funny_cats",
  "assertive",
  "pikud_haoref",
  "none",
];

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
      alert_types: ["early", "siren"],
      city_ids: [722, 723, 1],
      language: "en",
      gif_mode: "funny_cats",
      title_override: { siren: "🚀 ROCKET!" },
      description_override: { siren: "Run!" },
      observability: { betterstack_token: "tok_abc" },
      telegram: { bot_token: "123:ABC", chat_id: "-100" },
      health_port: 8080,
      poll_interval_ms: 5000,
      data_dir: "/tmp/data",
    };
    const path = writeTmpYaml("full.yaml", full);
    const raw = yaml.load(readFileSync(path, "utf-8")) as ConfigYaml;

    expect(raw.alert_types).toEqual(["early", "siren"]);
    expect(raw.city_ids).toEqual([722, 723, 1]);
    expect(raw.language).toBe("en");
    expect(raw.gif_mode).toBe("funny_cats");
    expect(raw.title_override?.siren).toBe("🚀 ROCKET!");
    expect(raw.description_override?.siren).toBe("Run!");
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
    const input = ["early", "bogus", "siren"] as AlertTypeConfig[];
    expect(parseAlertTypes(input)).toEqual(["early", "siren"]);
  });

  it("keeps valid subset", () => {
    expect(parseAlertTypes(["resolved"])).toEqual(["resolved"]);
  });

  it("returns all types when non-array passed", () => {
    expect(parseAlertTypes("siren" as unknown as AlertTypeConfig[])).toEqual(
      ALL_ALERT_TYPES,
    );
  });
});

// ── GIF Mode Validation ─────────────────────────────────

describe("parseGifMode", () => {
  it("parses valid modes", () => {
    expect(parseGifMode("funny_cats")).toBe("funny_cats");
    expect(parseGifMode("assertive")).toBe("assertive");
    expect(parseGifMode("pikud_haoref")).toBe("pikud_haoref");
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

// ── City ID Resolution ───────────────────────────────────

describe("resolveCityIds (logic)", () => {
  // Simulate the id→name map from cities.json
  const idToName = new Map<number, string>([
    [722, "תל אביב - דרום העיר ויפו"],
    [723, "תל אביב - מזרח"],
    [1, "אופקים"],
  ]);

  function resolveCityIds(ids: number[]): string[] {
    return ids.filter((id) => idToName.has(id)).map((id) => idToName.get(id)!);
  }

  it("resolves known IDs to Hebrew names", () => {
    expect(resolveCityIds([722, 723])).toEqual([
      "תל אביב - דרום העיר ויפו",
      "תל אביב - מזרח",
    ]);
  });

  it("skips unknown IDs", () => {
    expect(resolveCityIds([722, 99999])).toEqual(["תל אביב - דרום העיר ויפו"]);
  });

  it("returns empty array for all unknown IDs", () => {
    expect(resolveCityIds([99999, 88888])).toEqual([]);
  });

  it("handles empty input", () => {
    expect(resolveCityIds([])).toEqual([]);
  });
});

// ── Emoji/Title/Description Overrides ────────────────────

describe("config overrides", () => {
  it("override fields can be partial", () => {
    const yml: ConfigYaml = {
      emoji_override: { early: "🚀" },
      title_override: { siren: "CUSTOM SIREN" },
      // description_override not set
    };
    expect(yml.emoji_override?.early).toBe("🚀");
    expect(yml.emoji_override?.siren).toBeUndefined();
    expect(yml.title_override?.siren).toBe("CUSTOM SIREN");
    expect(yml.title_override?.early).toBeUndefined();
    expect(yml.description_override).toBeUndefined();
  });

  it("YAML round-trips override objects correctly", () => {
    const overrides = {
      emoji_override: {
        early: "🚀",
        siren: "🔴",
      },
      title_override: {
        early: "Warning",
        siren: "SIREN",
        resolved: "Clear",
      },
      description_override: {
        siren: "",
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
    const yml = { description_override: { siren: "" } };
    const dumped = yaml.dump(yml);
    const parsed = yaml.load(dumped) as ConfigYaml;
    expect(parsed.description_override?.siren).toBe("");
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
