/**
 * Resolve area relevance — 3-tier matching:
 *
 *  1. Exact / substring match against user's monitored areas
 *  2. cityMap / zoneMap hierarchy from i18n (ZONE_HIERARCHY)
 *  3. LLM fallback: "Is '{userArea}' part of '{mentioned}'?"
 */

import { ZONE_HIERARCHY } from "@easyoref/shared";
import { freeModel } from "../models.js";

// ── Tier 1: direct string matching ────────────────────────

function directMatch(mentioned: string, userAreas: string[]): string[] {
  const m = mentioned.toLowerCase().trim();
  return userAreas.filter((a) => {
    const n = a.toLowerCase().trim();
    return n === m || n.includes(m) || m.includes(n);
  });
}

// ── Tier 2: geo-hierarchy via ZONE_HIERARCHY ──────────────

function hierarchyMatch(mentioned: string, userAreas: string[]): string[] {
  const m = mentioned.trim();
  const matched: string[] = [];

  for (const userArea of userAreas) {
    const meta = ZONE_HIERARCHY[userArea as keyof typeof ZONE_HIERARCHY];
    if (!meta) continue;

    const candidates = [meta.city, meta.area, meta.macro].filter(
      Boolean,
    ) as string[];
    for (const candidate of candidates) {
      if (
        candidate.toLowerCase() === m.toLowerCase() ||
        m.toLowerCase().includes(candidate.toLowerCase()) ||
        candidate.toLowerCase().includes(m.toLowerCase())
      ) {
        matched.push(userArea);
        break;
      }
    }
  }

  return matched;
}

// ── Tier 3: LLM fallback ──────────────────────────────────

async function llmMatch(
  mentioned: string,
  userAreas: string[],
): Promise<string[]> {
  try {
    const matched: string[] = [];

    const prompt =
      `Answer ONLY with a JSON array of indices (0-based) of the user zones that are ` +
      `located inside or are part of "${mentioned}".\n` +
      `User zones:\n` +
      userAreas.map((a, i) => `${i}: ${a}`).join("\n") +
      `\nRespond with only: [0, 2] or [] — no other text.`;

    const result = await (freeModel as any).invoke(prompt);
    const text = typeof result === "string" ? result : (result?.content ?? "");
    const match = text.match(/\[[\d,\s]*\]/);
    if (match) {
      const indices: number[] = JSON.parse(match[0]);
      for (const idx of indices) {
        if (idx >= 0 && idx < userAreas.length) {
          matched.push(userAreas[idx]!);
        }
      }
    }
    return matched;
  } catch {
    return [];
  }
}

// ── Main export ────────────────────────────────────────────

export interface ResolveAreaResult {
  relevant: boolean;
  matchedAreas: string[];
  tier: "exact" | "hierarchy" | "llm" | "none";
  reasoning: string;
}

export async function resolveArea(
  mentioned: string,
  userAreas: string[],
): Promise<ResolveAreaResult> {
  if (!mentioned || !userAreas.length) {
    return {
      relevant: false,
      matchedAreas: [],
      tier: "none",
      reasoning: "No areas to check",
    };
  }

  // Tier 1
  const exact = directMatch(mentioned, userAreas);
  if (exact.length > 0) {
    return {
      relevant: true,
      matchedAreas: exact,
      tier: "exact",
      reasoning: `"${mentioned}" directly matches: ${exact.join(", ")}`,
    };
  }

  // Tier 2
  const hier = hierarchyMatch(mentioned, userAreas);
  if (hier.length > 0) {
    return {
      relevant: true,
      matchedAreas: hier,
      tier: "hierarchy",
      reasoning: `"${mentioned}" covers zones via geo-hierarchy: ${hier.join(", ")}`,
    };
  }

  // Tier 3
  const llm = await llmMatch(mentioned, userAreas);
  if (llm.length > 0) {
    return {
      relevant: true,
      matchedAreas: llm,
      tier: "llm",
      reasoning: `LLM confirmed "${mentioned}" contains: ${llm.join(", ")}`,
    };
  }

  return {
    relevant: false,
    matchedAreas: [],
    tier: "none",
    reasoning: `"${mentioned}" does not match any of: ${userAreas.join(", ")}`,
  };
}
