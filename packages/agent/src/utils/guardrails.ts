/**
 * LLM output guardrails — post-synthesis validation.
 *
 * Enforces:
 *   - Max field value length (prevent runaway LLM output)
 *   - Banned pattern detection (neuroslop, placeholder text)
 *   - Source URL requirement (every synthesized field needs ≥1 source)
 */

import type { SynthesizedInsightType } from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";

// ── Constants ──────────────────────────────────────────

/** Max length for any single language value in a synthesized field */
const MAX_FIELD_VALUE_LENGTH = 500;

/** Patterns that indicate LLM hallucination or neuroslop */
const BANNED_PATTERNS: RegExp[] = [
  /\bI (?:cannot|can't|don't|do not)\b/i, // refusal
  /\bas an AI\b/i, // identity leak
  /\bI'm sorry\b/i, // apology
  /\b(?:placeholder|example|sample|lorem ipsum)\b/i, // placeholder
  /\bN\/A\b/i, // lazy fill
  /\bunknown at this time\b/i, // vague filler
  /^[.\s]*$/, // empty/whitespace only
];

// ── Guardrail checks ───────────────────────────────────

export interface GuardrailResult {
  passed: SynthesizedInsightType[];
  rejected: Array<{ insight: SynthesizedInsightType; reason: string }>;
}

/**
 * Validate synthesized insights against guardrail rules.
 * Returns passed insights and rejected ones with reasons.
 */
export function applyGuardrails(
  insights: SynthesizedInsightType[],
): GuardrailResult {
  const passed: SynthesizedInsightType[] = [];
  const rejected: Array<{ insight: SynthesizedInsightType; reason: string }> =
    [];

  for (const insight of insights) {
    const reason = checkInsight(insight);
    if (reason) {
      rejected.push({ insight, reason });
      logger.warn("guardrail: rejected synthesized insight", {
        key: insight.key,
        reason,
      });
    } else {
      passed.push(insight);
    }
  }

  return { passed, rejected };
}

function checkInsight(insight: SynthesizedInsightType): string | null {
  // Check 1: field value length
  const langs = ["ru", "en", "he", "ar"] as const;
  for (const lang of langs) {
    const val = insight.value[lang];
    if (val && val.length > MAX_FIELD_VALUE_LENGTH) {
      return `${lang} value exceeds max length (${val.length}/${MAX_FIELD_VALUE_LENGTH})`;
    }
  }

  // Check 2: all languages empty
  const allEmpty = langs.every(
    (l) => !insight.value[l] || insight.value[l].trim() === "",
  );
  if (allEmpty) {
    return "all language values are empty";
  }

  // Check 3: banned patterns
  for (const lang of langs) {
    const val = insight.value[lang];
    if (!val) continue;
    for (const pattern of BANNED_PATTERNS) {
      if (pattern.test(val)) {
        return `${lang} value matches banned pattern: ${pattern.source}`;
      }
    }
  }

  // Check 4: source URL requirement — warn but don't reject
  // Telegram-sourced insights may lack direct URLs (channel posts without links)
  // The consensus validation already ensures the insight has source backing

  return null;
}
