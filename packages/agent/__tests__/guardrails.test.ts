/**
 * Guardrail unit tests — LLM output validation.
 *
 * Covers:
 *   - Max field value length
 *   - Banned pattern detection (neuroslop / placeholders)
 *   - Source URL requirement
 *   - All-empty language values rejection
 */

import type { SynthesizedInsightType } from "@easyoref/shared";
import { describe, expect, it } from "vitest";
import { applyGuardrails } from "../src/utils/guardrails.js";

function makeSynthesized(
  overrides: Partial<SynthesizedInsightType> = {},
): SynthesizedInsightType {
  return {
    key: "origin",
    value: {
      ru: "Иран",
      en: "Iran",
      he: "איראן",
      ar: "إيران",
    },
    confidence: 0.85,
    sourceUrls: ["https://t.me/channel/123"],
    ...overrides,
  };
}

describe("applyGuardrails", () => {
  it("passes a valid insight", () => {
    const { passed, rejected } = applyGuardrails([makeSynthesized()]);
    expect(passed).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it("rejects insight with overlong field value", () => {
    const { passed, rejected } = applyGuardrails([
      makeSynthesized({
        value: {
          ru: "x".repeat(600),
          en: "Iran",
          he: "איראן",
          ar: "إيران",
        },
      }),
    ]);
    expect(passed).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("max length");
  });

  it("rejects insight with all empty language values", () => {
    const { passed, rejected } = applyGuardrails([
      makeSynthesized({
        value: { ru: "", en: "  ", he: "", ar: "" },
      }),
    ]);
    expect(passed).toHaveLength(0);
    expect(rejected[0].reason).toContain("all language values are empty");
  });

  it("rejects insight matching banned pattern — AI identity", () => {
    const { passed, rejected } = applyGuardrails([
      makeSynthesized({
        value: {
          ru: "Иран",
          en: "As an AI, I cannot determine the origin",
          he: "איראן",
          ar: "إيران",
        },
      }),
    ]);
    expect(passed).toHaveLength(0);
    expect(rejected[0].reason).toContain("banned pattern");
  });

  it("rejects insight matching banned pattern — refusal", () => {
    const { rejected } = applyGuardrails([
      makeSynthesized({
        value: {
          ru: "I cannot provide this information",
          en: "Iran",
          he: "איראן",
          ar: "إيران",
        },
      }),
    ]);
    expect(rejected).toHaveLength(1);
  });

  it("rejects insight matching banned pattern — placeholder", () => {
    const { rejected } = applyGuardrails([
      makeSynthesized({
        value: {
          ru: "placeholder",
          en: "Iran",
          he: "איראן",
          ar: "إيران",
        },
      }),
    ]);
    expect(rejected).toHaveLength(1);
  });

  it("passes insight with no source URLs (warn only — Telegram sources may lack URLs)", () => {
    const { passed, rejected } = applyGuardrails([
      makeSynthesized({ sourceUrls: [] }),
    ]);
    expect(passed).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it("passes multiple good insights and rejects bad ones", () => {
    const { passed, rejected } = applyGuardrails([
      makeSynthesized({ key: "origin" }),
      makeSynthesized({
        key: "eta_absolute",
        value: { ru: "", en: "", he: "", ar: "" },
      }),
      makeSynthesized({ key: "rocket_count" }),
    ]);
    expect(passed).toHaveLength(2);
    expect(passed.map((p) => p.key)).toEqual(["origin", "rocket_count"]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].insight.key).toBe("eta_absolute");
  });

  it("rejects insight with N/A value", () => {
    const { rejected } = applyGuardrails([
      makeSynthesized({
        value: { ru: "N/A", en: "Iran", he: "איראן", ar: "إيران" },
      }),
    ]);
    expect(rejected).toHaveLength(1);
  });

  it("passes insight with I'm in non-English context (Hebrew)", () => {
    // "I'm sorry" pattern should NOT match Hebrew/Arabic/Russian text
    const { passed } = applyGuardrails([
      makeSynthesized({
        value: {
          ru: "Иран + Ливан",
          en: "Iran + Lebanon",
          he: "איראן + לבנון",
          ar: "إيران + لبنان",
        },
      }),
    ]);
    expect(passed).toHaveLength(1);
  });
});
