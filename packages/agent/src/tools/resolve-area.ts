/**
 * Resolve area relevance — 3-tier matching:
 *
 *  1. Exact / substring match against user's monitored areas (free, O(n))
 *  2. cityMap / zoneMap hierarchy from i18n (free, uses loaded Oref data)
 *  3. LLM fallback: "Is '{userArea}' part of '{mentioned}'?" (gpt-oss-120b:free)
 *
 * The key question is always:
 *   "Is the user's zone X a part of / inside the region Y mentioned in news?"
 *
 * NOT: "are X and Y in the same zone?" (wrong direction — misses macro coverage).
 */

import { config } from "@easyoref/shared";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { freeModel } from "../models.js";

// ── Tier 1: direct string matching ────────────────────────

function directMatch(mentioned: string, userAreas: string[]): string[] {
  const m = mentioned.toLowerCase().trim();
  return userAreas.filter((a) => {
    const n = a.toLowerCase().trim();
    return n === m || n.includes(m) || m.includes(n);
  });
}

// ── Tier 2: geo-hierarchy via cityMap / zoneMap from i18n ─

/**
 * Access i18n maps exported from shared.
 * They're populated after initTranslations(), but we can access the module-level
 * maps by calling translateAreas — however those aren't exported directly.
 *
 * Alternative approach: use ZONE_HIERARCHY from zone-priority which covers
 * the most common Oref API zones (Tel Aviv zones → area=גוש דן, macro=מרכז).
 * For everything else: fall through to LLM.
 */
import { ZONE_HIERARCHY } from "@easyoref/shared";

function hierarchyMatch(mentioned: string, userAreas: string[]): string[] {
  const m = mentioned.trim();
  const matched: string[] = [];

  for (const userArea of userAreas) {
    const meta = ZONE_HIERARCHY[userArea as keyof typeof ZONE_HIERARCHY];
    if (!meta) continue;

    // Check if mentioned matches city, area, or macro of this user zone
    const candidates = [meta.city, meta.area, meta.macro].filter(Boolean) as string[];
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

    // Batch all userAreas into a single prompt to save tokens
    const prompt =
      `Answer ONLY with a JSON array of indices (0-based) of the user zones that are ` +
      `located inside or are part of "${mentioned}".\n` +
      `User zones:\n` +
      userAreas.map((a, i) => `${i}: ${a}`).join("\n") +
      `\nRespond with only: [0, 2] or [] — no other text.`;

    const result = await (freeModel as any).invoke(prompt);
    const text = typeof result === "string" ? result : result?.content ?? "";
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

/**
 * Resolve whether `mentioned` (location from news) contains any of `userAreas`.
 * Used in post-filter-node (for insightLocation flag) and as clarify ReAct tool.
 */
export async function resolveArea(
  mentioned: string,
  userAreas: string[],
): Promise<ResolveAreaResult> {
  if (!mentioned || !userAreas.length) {
    return { relevant: false, matchedAreas: [], tier: "none", reasoning: "No areas to check" };
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

// ── ReAct tool (for clarify-node) ─────────────────────────

export const resolveAreaTool = tool(
  async ({ location }: { location: string }): Promise<string> => {
    const userAreas = config.areas;

    if (!userAreas.length) {
      return JSON.stringify({ error: "No monitored areas configured" });
    }

    const result = await resolveArea(location, userAreas);

    return JSON.stringify({
      location,
      monitored_areas: userAreas,
      relevant: result.relevant,
      matched_areas: result.matchedAreas,
      tier: result.tier,
      reasoning: result.reasoning,
    });
  },
  {
    name: "resolve_area",
    description:
      "Determine if a location mentioned in news is relevant to the user's monitored zones. " +
      "Checks whether the user's zone is inside or part of the mentioned area. " +
      'Example: user monitors "תל אביב - מרכז העיר", news says "מרכז" → relevant. ' +
      'Example: user monitors Tel Aviv zones, news says "Petah Tikva hit" → NOT relevant. ' +
      "Use when news mentions a city/region and you need to decide if it affects the user.",
    schema: z.object({
      location: z
        .string()
        .describe("City or region name as mentioned in news (Hebrew preferred, e.g. מרכז, פתח תקווה)"),
    }),
  },
);
