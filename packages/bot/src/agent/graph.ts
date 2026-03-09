/**
 * LangGraph.js enrichment pipeline — phase-aware, time-validated.
 *
 * KEY DESIGN PRINCIPLES:
 *   1. TIME IS KING — every post is validated against the alert time window.
 *      LLM receives alert time + post time and scores time_relevance.
 *      Posts about previous/different attacks are rejected.
 *   2. PHASE-AWARE — each phase extracts only what's relevant:
 *      - early_warning: origin, ETA, rocket count, cassette
 *      - siren: carries early data + adds interception, impacts
 *      - resolved: carries all + adds casualties, injuries, final stats
 *   3. CARRY-FORWARD — results persist in Redis (EnrichmentData).
 *      Each phase inherits previous phase's findings.
 *   4. INLINE CITATIONS — no superscripts, no footer sources.
 *      Format: [[1]](url) right after each data point.
 *   5. DEDUP EDITS — hash-based check prevents "message not modified" spam.
 *
 * Pipeline:
 *   preFilter → extractAndValidate → postFilter → vote → [clarify] → editMessage
 */

import { Annotation, MemorySaver, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { Bot } from "grammy";
import { createHash } from "node:crypto";
import { config } from "../config.js";
import * as logger from "../logger.js";
import { runClarify } from "./clarify.js";
import type { ChannelPost } from "./store.js";
import {
  getActiveSession,
  getChannelPosts,
  getEnrichmentData,
  saveEnrichmentData,
} from "./store.js";
import type {
  AlertType,
  CitedSource,
  EnrichmentData,
  ExtractionResult,
  InlineCite,
  QualCount,
  ValidatedExtraction,
  VotedResult,
} from "./types.js";
import { emptyEnrichmentData } from "./types.js";

// ── State ──────────────────────────────────────────────

const AgentState = Annotation.Root({
  alertId: Annotation<string>({ reducer: (_, b) => b }),
  alertTs: Annotation<number>({ reducer: (_, b) => b }),
  alertType: Annotation<AlertType>({ reducer: (_, b) => b }),
  alertAreas: Annotation<string[]>({ reducer: (_, b) => b }),
  chatId: Annotation<string>({ reducer: (_, b) => b }),
  messageId: Annotation<number>({ reducer: (_, b) => b }),
  isCaption: Annotation<boolean>({ reducer: (_, b) => b }),
  currentText: Annotation<string>({ reducer: (_, b) => b }),
  channelPosts: Annotation<ChannelPost[]>({ reducer: (_, b) => b }),
  filteredPosts: Annotation<ChannelPost[]>({ reducer: (_, b) => b }),
  extractions: Annotation<ValidatedExtraction[]>({ reducer: (_, b) => b }),
  votedResult: Annotation<VotedResult | null>({ reducer: (_, b) => b }),
  /** Tracks whether clarify has already run (prevents infinite loop) */
  clarifyAttempted: Annotation<boolean>({ reducer: (_, b) => b }),
  /** Cross-phase enrichment data loaded at start */
  previousEnrichment: Annotation<EnrichmentData>({ reducer: (_, b) => b }),
  /** Session start timestamp for time window calculations */
  sessionStartTs: Annotation<number>({ reducer: (_, b) => b }),
  /** Phase start timestamp */
  phaseStartTs: Annotation<number>({ reducer: (_, b) => b }),
});

type AgentStateType = typeof AgentState.State;

// ── LLM ───────────────────────────────────────────────

function getLLM(): ChatOpenAI {
  return new ChatOpenAI({
    model: config.agent.model,
    configuration: {
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/mikhailkogan17/EasyOref",
        "X-Title": "EasyOref",
      },
    },
    apiKey: config.agent.apiKey,
    temperature: 0,
    maxTokens: 500,
  });
}

// ── Region keywords (Hebrew + transliterations) ────────

function buildRegionKeywords(): string[] {
  const keywords: string[] = [];

  for (const area of config.areas) {
    keywords.push(area.toLowerCase());
    const first = area.split(" ")[0];
    if (first && first.length >= 2) keywords.push(first.toLowerCase());
  }

  for (const [he, label] of Object.entries(config.agent.areaLabels)) {
    keywords.push(he.toLowerCase());
    for (const word of label.split(/\s+/)) {
      if (word.length >= 3) keywords.push(word.toLowerCase());
    }
  }

  // Common attack-related keywords (always relevant)
  keywords.push(
    "ישראל",
    "israel",
    "израиль",
    "ракет",
    "rocket",
    "missile",
    "iron dome",
    "כיפת ברזל",
    "перехват",
    "intercept",
    "צבע אדום",
    "red alert",
  );

  return [...new Set(keywords)];
}

// ── Launch detection keywords (strict — early_warning only) ──

const LAUNCH_KEYWORDS = [
  "שיגור",
  "שיגורים",
  "שוגרו",
  "נורו",
  "зафиксированы запуски",
  "обнаружены запуски",
  "запуски ракет",
  "запуск ракет",
  "пуски ракет",
  "ракетный обстрел",
  "ракетная атака",
  "missile launch",
  "rocket launch",
  "barrage",
  "fired towards",
  "launches detected",
  "missiles fired",
  "שיגורים לישראל",
  "ירי טילים",
  "ירי רקטות",
  "إطلاق صواريخ",
].map((kw) => kw.toLowerCase());

// ── Time window per phase (ms before alertTs to accept posts) ──

const TIME_WINDOW_MS: Record<AlertType, number> = {
  early_warning: 5 * 60 * 1000, // 5 min before alert
  siren: 10 * 60 * 1000, // 10 min (includes early_warning period)
  resolved: 30 * 60 * 1000, // 30 min (full session window)
};

// ── Helpers ────────────────────────────────────────────

/** Format timestamp as HH:MM Israel time */
function toIsraelTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("he-IL", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jerusalem",
  });
}

/** MD5 hash for edit dedup */
function textHash(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

// ─────────────────────────────────────────────────────────
// Tier 0: Pre-filter (phase-aware, time-bounded, 0 tokens)
// ─────────────────────────────────────────────────────────

async function collectAndPreFilter(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const posts = await getChannelPosts(state.alertId);
  const prevEnrichment = await getEnrichmentData();

  // Load session for time boundaries
  const session = await getActiveSession();
  const sessionStartTs = session?.sessionStartTs ?? state.alertTs;
  const phaseStartTs = session?.phaseStartTs ?? state.alertTs;

  if (posts.length === 0) {
    logger.info("Agent: no posts in session", { alertId: state.alertId });
    return {
      channelPosts: posts,
      filteredPosts: [],
      previousEnrichment: prevEnrichment,
      sessionStartTs,
      phaseStartTs,
    };
  }

  const keywords = buildRegionKeywords();
  const alertType = state.alertType;
  const alertTs = state.alertTs;

  // Time window: reject posts older than window before alertTs
  const windowMs = TIME_WINDOW_MS[alertType];
  const cutoffTs = alertTs - windowMs;

  let filtered: ChannelPost[];

  if (alertType === "early_warning") {
    // ── STRICT launch-only filter for early warning ──
    // Step 1: Find posts with launch keywords, within time window
    const launchPosts = posts.filter((post) => {
      if (post.ts < cutoffTs) return false;
      const text = post.text.toLowerCase();
      return LAUNCH_KEYWORDS.some((kw) => text.includes(kw));
    });

    // Step 2: Get channels that posted about launches
    const channelFirstLaunchTs = new Map<string, number>();
    for (const post of launchPosts) {
      const current = channelFirstLaunchTs.get(post.channel);
      if (current === undefined || post.ts < current) {
        channelFirstLaunchTs.set(post.channel, post.ts);
      }
    }

    // Step 3: Accept follow-up posts from launch channels only (within window)
    filtered = posts.filter((post) => {
      if (post.ts < cutoffTs) return false;
      const text = post.text.toLowerCase();
      if (!keywords.some((kw) => text.includes(kw))) return false;
      const firstLaunch = channelFirstLaunchTs.get(post.channel);
      if (firstLaunch === undefined) return false;
      return post.ts >= firstLaunch;
    });

    logger.info("Agent: pre-filter (early_warning)", {
      alertId: state.alertId,
      total: posts.length,
      launch_posts: launchPosts.length,
      launch_channels: channelFirstLaunchTs.size,
      after_filter: filtered.length,
      cutoff: toIsraelTime(cutoffTs),
    });
  } else {
    // ── Siren & Resolved: broader filter, time-bounded ──
    filtered = posts.filter((post) => {
      if (post.ts < cutoffTs) return false;
      const text = post.text.toLowerCase();
      return keywords.some((kw) => text.includes(kw));
    });

    logger.info("Agent: pre-filter", {
      alertId: state.alertId,
      alertType,
      total: posts.length,
      after_filter: filtered.length,
      cutoff: toIsraelTime(cutoffTs),
    });
  }

  return {
    channelPosts: posts,
    filteredPosts: filtered,
    previousEnrichment: prevEnrichment,
    sessionStartTs,
    phaseStartTs,
  };
}

// ─────────────────────────────────────────────────────────
// Tier 1: Extract + validate (1 LLM call per post)
// Phase-aware prompts — agent knows what to look for.
// TIME CONTEXT — agent sees alert time + post time.
// ─────────────────────────────────────────────────────────

const QUAL_VALUES =
  '"all"|"most"|"many"|"few"|"exists"|"none"|"more_than"|"less_than"';

/** Phase-specific extraction instructions */
function getPhaseInstructions(alertType: AlertType): string {
  switch (alertType) {
    case "early_warning":
      return `PHASE: EARLY WARNING (radar detected launches, sirens not yet).
Focus on: country_origin (WHERE were rockets launched from?), eta_refined_minutes, rocket_count, is_cassette.
Do NOT extract: intercepted, sea_impact, open_area_impact, hits_confirmed, casualties, injuries — these are IMPOSSIBLE at this stage.
If a message discusses interception results, it is about a PREVIOUS attack — set time_relevance=0.`;

    case "siren":
      return `PHASE: SIREN (rockets incoming, impact imminent).
Focus on: country_origin (if not known yet), rocket_count, intercepted, sea_impact, open_area_impact, is_cassette.
Do NOT extract: hits_confirmed, casualties, injuries — too early for confirmed damage reports.
If a message discusses casualties or confirmed hits, verify the timing carefully - it may be about a previous attack.`;

    case "resolved":
      return `PHASE: RESOLVED (incident over, assessing damage).
Focus on: intercepted (final count), hits_confirmed, casualties, injuries, open_area_impact.
All fields are valid at this stage. Prioritize confirmed official reports.`;
  }
}

const SYSTEM_PROMPT_BASE = `You analyze Telegram channel messages about a missile/rocket attack on Israel.
Your job: extract factual data, assess quality, AND validate temporal relevance.

CRITICAL — TIME VALIDATION:
You will receive the alert time and the post time. You MUST determine if this post
is about the CURRENT attack or about a previous/different event.
- If post discusses events clearly BEFORE the alert time → time_relevance=0
- If post is generic military news not specific to this attack → time_relevance=0.2
- If post discusses the current attack → time_relevance=1.0
- If uncertain → time_relevance=0.5 (the system will use alert_history to verify)

Return ONLY valid JSON (no markdown, no explanation):
{
  "region_relevance": float,       // 0–1: does this message discuss the specified alert region?
  "source_trust": float,           // 0–1: factual reporting (1.0) vs unverified rumors/panic (0.0)
  "tone": "calm"|"neutral"|"alarmist",
  "time_relevance": float,         // 0–1: is this post about the CURRENT attack? (see rules above)
  "country_origin": string|null,   // "Iran","Yemen","Lebanon","Gaza","Iraq","Syria" or null
  "rocket_count": int|null,
  "is_cassette": bool|null,
  "intercepted": int|null,
  "intercepted_qual": ${QUAL_VALUES}|null,
  "intercepted_qual_num": int|null,
  "sea_impact": int|null,
  "sea_impact_qual": ${QUAL_VALUES}|null,
  "sea_impact_qual_num": int|null,
  "open_area_impact": int|null,
  "open_area_impact_qual": ${QUAL_VALUES}|null,
  "open_area_impact_qual_num": int|null,
  "hits_confirmed": int|null,
  "casualties": int|null,
  "injuries": int|null,
  "eta_refined_minutes": int|null,
  "confidence": float
}

Rules:
- If unrelated to the alert region, set region_relevance=0 and all data fields to null.
- If message is speculative/unconfirmed rumor, set source_trust < 0.4.
- If message uses excessive caps, exclamation marks, panic language → tone="alarmist".
- Only extract concrete numbers explicitly stated in the text. Never guess.
- *_qual fields: use ONLY when NO exact count is given. If exact number present, set *_qual=null.
- "none" qual is only valid if explicitly stated (e.g., "все перехвачены", "не упало в море").
- For IDF (@idf_telegram) posts about ongoing operations (not this specific attack) → time_relevance=0.
- LANGUAGE NEUTRALITY: Posts may be in Hebrew, Russian, Arabic, or English. The language of the post
  MUST NOT affect source_trust or confidence. Russian-language Israeli channels are equally reliable
  and often break news faster than Hebrew ones. Judge ONLY by factual content and tone.`;

async function extractAndValidate(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  if (state.filteredPosts.length === 0) {
    logger.info("Agent: no filtered posts to extract", {
      alertId: state.alertId,
    });
    return { extractions: [] };
  }

  const llm = getLLM();
  const posts = state.filteredPosts.slice(0, 8); // max 8 posts

  const regionHint =
    state.alertAreas.length > 0
      ? state.alertAreas.join(", ")
      : Object.keys(config.agent.areaLabels).join(", ") || "Israel";

  const alertTimeIL = toIsraelTime(state.alertTs);
  const nowIL = toIsraelTime(Date.now());
  const phaseInstructions = getPhaseInstructions(state.alertType);

  const systemPrompt = SYSTEM_PROMPT_BASE + "\n\n" + phaseInstructions;

  const results = await Promise.all(
    posts.map(async (post): Promise<ValidatedExtraction> => {
      const postTimeIL = toIsraelTime(post.ts);
      const postAgeMin = Math.round((state.alertTs - post.ts) / 60_000);
      const postAgeSuffix =
        postAgeMin > 0
          ? `(${postAgeMin} min BEFORE alert)`
          : postAgeMin < 0
          ? `(${Math.abs(postAgeMin)} min AFTER alert)`
          : "(same time as alert)";

      const contextHeader =
        `Alert time: ${alertTimeIL} (Israel)\n` +
        `Post time:  ${postTimeIL} (Israel) ${postAgeSuffix}\n` +
        `Current time: ${nowIL} (Israel)\n` +
        `Alert region: ${regionHint}\n` +
        `UI language: ${config.language}\n`;

      try {
        const response = await llm.invoke([
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `${contextHeader}Channel: ${
              post.channel
            }\n\nMessage:\n${post.text.slice(0, 800)}`,
          },
        ]);

        const raw =
          typeof response.content === "string"
            ? response.content
            : JSON.stringify(response.content);

        const text = raw
          .replace(/^```(?:json)?\s*\n?/i, "")
          .replace(/\n?```\s*$/i, "");

        const parsed = JSON.parse(text.trim()) as ExtractionResult;
        return {
          ...parsed,
          channel: post.channel,
          messageUrl: post.messageUrl,
          time_relevance: parsed.time_relevance ?? 0.5,
          valid: true,
        };
      } catch (err) {
        logger.warn("Agent: extraction failed", {
          channel: post.channel,
          error: String(err),
        });
        return {
          channel: post.channel,
          region_relevance: 0,
          source_trust: 0,
          tone: "neutral" as const,
          time_relevance: 0,
          country_origin: null,
          rocket_count: null,
          is_cassette: null,
          intercepted: null,
          intercepted_qual: null,
          intercepted_qual_num: null,
          sea_impact: null,
          sea_impact_qual: null,
          sea_impact_qual_num: null,
          open_area_impact: null,
          open_area_impact_qual: null,
          open_area_impact_qual_num: null,
          hits_confirmed: null,
          casualties: null,
          injuries: null,
          eta_refined_minutes: null,
          confidence: 0,
          valid: false,
          reject_reason: "extraction_error",
        };
      }
    }),
  );

  logger.info("Agent: extracted", {
    alertId: state.alertId,
    count: results.length,
    timeRelevance: results.map((r) => ({
      ch: r.channel,
      tr: r.time_relevance,
    })),
  });

  return { extractions: results };
}

// ─────────────────────────────────────────────────────────
// Tier 2: Post-filter (deterministic, 0 tokens)
// Now includes TIME RELEVANCE check.
// ─────────────────────────────────────────────────────────

function postFilter(state: AgentStateType): Partial<AgentStateType> {
  const validated = state.extractions.map((ext): ValidatedExtraction => {
    // V0: TIME RELEVANCE — the most important check
    if (ext.time_relevance < 0.5) {
      return { ...ext, valid: false, reject_reason: "stale_post" };
    }

    // V1: region relevance
    if (ext.region_relevance < 0.5) {
      return { ...ext, valid: false, reject_reason: "region_irrelevant" };
    }
    // V2: source trust
    if (ext.source_trust < 0.4) {
      return { ...ext, valid: false, reject_reason: "untrusted_source" };
    }
    // V3: tone — reject alarmist
    if (ext.tone === "alarmist") {
      return { ...ext, valid: false, reject_reason: "alarmist_tone" };
    }
    // V4: at least one data field must be non-null
    const hasData =
      ext.country_origin !== null ||
      ext.rocket_count !== null ||
      ext.is_cassette !== null ||
      ext.intercepted !== null ||
      ext.intercepted_qual !== null ||
      ext.hits_confirmed !== null ||
      ext.casualties !== null ||
      ext.injuries !== null ||
      ext.eta_refined_minutes !== null;
    if (!hasData) {
      return { ...ext, valid: false, reject_reason: "no_data" };
    }
    // V5: overall confidence floor
    if (ext.confidence < 0.3) {
      return { ...ext, valid: false, reject_reason: "low_confidence" };
    }

    return { ...ext, valid: true };
  });

  const passed = validated.filter((e) => e.valid);
  const rejected = validated.filter((e) => !e.valid);

  logger.info("Agent: post-filter", {
    alertId: state.alertId,
    passed: passed.length,
    rejected: rejected.length,
    reasons: rejected.map((r) => r.reject_reason),
  });

  return { extractions: validated };
}

// ─────────────────────────────────────────────────────────
// Tier 3: Vote (deterministic, 0 tokens)
// ─────────────────────────────────────────────────────────

function vote(state: AgentStateType): Partial<AgentStateType> {
  const valid = state.extractions.filter((e) => e.valid);

  if (valid.length === 0) {
    return { votedResult: null };
  }

  // Assign 1-based citation indices
  const indexed = valid.map((e, i) => ({ ...e, idx: i + 1 }));

  const citedSources: CitedSource[] = indexed.map((e) => ({
    index: e.idx,
    channel: e.channel,
    messageUrl: e.messageUrl ?? null,
  }));

  // ETA: highest confidence source
  const withEta = indexed
    .filter((e) => e.eta_refined_minutes !== null)
    .sort((a, b) => b.confidence - a.confidence);
  const bestEta = withEta[0] ?? null;

  // Country: group unique values
  const countryMap = new Map<string, number[]>();
  for (const e of indexed) {
    if (e.country_origin) {
      const list = countryMap.get(e.country_origin) ?? [];
      list.push(e.idx);
      countryMap.set(e.country_origin, list);
    }
  }
  const country_origins =
    countryMap.size > 0
      ? Array.from(countryMap.entries()).map(([name, citations]) => ({
          name,
          citations,
        }))
      : null;

  // Rocket count: range
  const rocketSrcs = indexed.filter((e) => e.rocket_count !== null);
  const rocketVals = rocketSrcs.map((e) => e.rocket_count as number);
  const rocket_count_min =
    rocketVals.length > 0 ? Math.min(...rocketVals) : null;
  const rocket_count_max =
    rocketVals.length > 0 ? Math.max(...rocketVals) : null;
  const rocket_citations = rocketSrcs.map((e) => e.idx);

  // Helper: avg weighted confidence
  function fieldConf(
    srcs: Array<{ source_trust: number; confidence: number }>,
  ): number {
    if (srcs.length === 0) return 0;
    return (
      srcs.reduce((s, e) => s + e.source_trust * e.confidence, 0) / srcs.length
    );
  }

  // Helper: mode for QualCount
  function modeQual(
    srcs: Array<{ [k: string]: unknown }>,
    key: string,
  ): QualCount | null {
    const vals = srcs
      .map((e) => e[key] as QualCount | null)
      .filter((v): v is QualCount => v !== null);
    if (vals.length === 0) return null;
    const freq = new Map<QualCount, number>();
    for (const v of vals) freq.set(v, (freq.get(v) ?? 0) + 1);
    return [...freq.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  }

  function medianQualNum(
    srcs: Array<{ [k: string]: unknown }>,
    key: string,
  ): number | null {
    const vals = srcs
      .map((e) => e[key] as number | null)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);
    return vals.length > 0 ? vals[Math.floor(vals.length / 2)] : null;
  }

  // Cassette: majority
  const cassSrcs = indexed.filter((e) => e.is_cassette !== null);
  const cassVals = cassSrcs.map((e) => e.is_cassette as boolean);
  const is_cassette =
    cassVals.length > 0
      ? cassVals.filter(Boolean).length > cassVals.length / 2
      : null;
  const is_cassette_confidence = fieldConf(cassSrcs);

  // Hits: median
  const hitsSrcs = indexed.filter(
    (e) => e.hits_confirmed !== null && e.hits_confirmed > 0,
  );
  const hitsVals = indexed
    .filter((e) => e.hits_confirmed !== null)
    .map((e) => e.hits_confirmed as number)
    .sort((a, b) => a - b);
  const hits_confirmed =
    hitsVals.length > 0 ? hitsVals[Math.floor(hitsVals.length / 2)] : null;
  const hits_citations = hitsSrcs.map((e) => e.idx);
  const hits_confidence = fieldConf(hitsSrcs);

  // Intercepted: median / qual
  const interceptedSrcs = indexed.filter((e) => e.intercepted !== null);
  const interceptedQualSrcs = indexed.filter(
    (e) => e.intercepted_qual !== null,
  );
  const interceptedVals = interceptedSrcs
    .map((e) => e.intercepted as number)
    .sort((a, b) => a - b);
  const intercepted =
    interceptedVals.length > 0
      ? interceptedVals[Math.floor(interceptedVals.length / 2)]
      : null;
  const intercepted_qual =
    intercepted === null
      ? modeQual(interceptedQualSrcs, "intercepted_qual")
      : null;
  const intercepted_qual_num =
    intercepted_qual !== null
      ? medianQualNum(interceptedQualSrcs, "intercepted_qual_num")
      : null;
  const intercepted_confidence = fieldConf(
    interceptedSrcs.length > 0 ? interceptedSrcs : interceptedQualSrcs,
  );

  // Sea impact: median / qual
  const seaSrcs = indexed.filter((e) => e.sea_impact !== null);
  const seaQualSrcs = indexed.filter((e) => e.sea_impact_qual !== null);
  const seaVals = seaSrcs
    .map((e) => e.sea_impact as number)
    .sort((a, b) => a - b);
  const sea_impact =
    seaVals.length > 0 ? seaVals[Math.floor(seaVals.length / 2)] : null;
  const sea_impact_qual =
    sea_impact === null ? modeQual(seaQualSrcs, "sea_impact_qual") : null;
  const sea_impact_qual_num =
    sea_impact_qual !== null
      ? medianQualNum(seaQualSrcs, "sea_impact_qual_num")
      : null;
  const sea_confidence = fieldConf(seaSrcs.length > 0 ? seaSrcs : seaQualSrcs);

  // Open area impact: median / qual
  const openSrcs = indexed.filter((e) => e.open_area_impact !== null);
  const openQualSrcs = indexed.filter((e) => e.open_area_impact_qual !== null);
  const openVals = openSrcs
    .map((e) => e.open_area_impact as number)
    .sort((a, b) => a - b);
  const open_area_impact =
    openVals.length > 0 ? openVals[Math.floor(openVals.length / 2)] : null;
  const open_area_impact_qual =
    open_area_impact === null
      ? modeQual(openQualSrcs, "open_area_impact_qual")
      : null;
  const open_area_impact_qual_num =
    open_area_impact_qual !== null
      ? medianQualNum(openQualSrcs, "open_area_impact_qual_num")
      : null;
  const open_area_confidence = fieldConf(
    openSrcs.length > 0 ? openSrcs : openQualSrcs,
  );

  // Casualties
  const casualtySrcs = indexed.filter(
    (e) => e.casualties !== null && e.casualties > 0,
  );
  const casualtyVals = casualtySrcs
    .map((e) => e.casualties as number)
    .sort((a, b) => a - b);
  const casualties =
    casualtyVals.length > 0
      ? casualtyVals[Math.floor(casualtyVals.length / 2)]
      : null;
  const casualties_citations = casualtySrcs.map((e) => e.idx);
  const casualties_confidence = fieldConf(casualtySrcs);

  // Injuries
  const injurySrcs = indexed.filter(
    (e) => e.injuries !== null && (e.injuries as number) > 0,
  );
  const injuryVals = injurySrcs
    .map((e) => e.injuries as number)
    .sort((a, b) => a - b);
  const injuries =
    injuryVals.length > 0
      ? injuryVals[Math.floor(injuryVals.length / 2)]
      : null;
  const injuries_citations = injurySrcs.map((e) => e.idx);
  const injuries_confidence = fieldConf(injurySrcs);

  // Rocket confidence
  const rocket_confidence = fieldConf(rocketSrcs);

  // Overall weighted confidence
  const totalWeight = indexed.reduce(
    (s, e) => s + e.source_trust * e.confidence,
    0,
  );
  const weightedConf = totalWeight / indexed.length;

  const voted: VotedResult = {
    eta_refined_minutes: bestEta?.eta_refined_minutes ?? null,
    eta_citations: bestEta ? [bestEta.idx] : [],
    country_origins,
    rocket_count_min,
    rocket_count_max,
    rocket_citations,
    rocket_confidence,
    is_cassette,
    is_cassette_confidence,
    intercepted,
    intercepted_qual,
    intercepted_qual_num,
    intercepted_confidence,
    sea_impact,
    sea_impact_qual,
    sea_impact_qual_num,
    sea_confidence,
    open_area_impact,
    open_area_impact_qual,
    open_area_impact_qual_num,
    open_area_confidence,
    hits_confirmed,
    hits_citations,
    hits_confidence,
    casualties,
    casualties_citations,
    casualties_confidence,
    injuries,
    injuries_citations,
    injuries_confidence,
    confidence: Math.round(weightedConf * 100) / 100,
    sources_count: indexed.length,
    citedSources,
  };

  logger.info("Agent: voted", { alertId: state.alertId, voted });
  return { votedResult: voted };
}

// ─────────────────────────────────────────────────────────
// Tier 4: Edit message — inline citations, carry-forward
// ─────────────────────────────────────────────────────────

/** EN country name → Russian */
const COUNTRY_RU: Record<string, string> = {
  Iran: "Иран",
  Yemen: "Йемен",
  Lebanon: "Ливан",
  Gaza: "Газа",
  Iraq: "Ирак",
  Syria: "Сирия",
  Hezbollah: "Хезболла",
};

/** Format inline citations: [[1]](url), [[2]](url) */
function inlineCites(indices: number[], citedSources: CitedSource[]): string {
  const parts: string[] = [];
  for (const idx of indices) {
    const src = citedSources.find((s) => s.index === idx);
    if (src?.messageUrl) {
      parts.push(`<a href="${src.messageUrl}">[${idx}]</a>`);
    }
  }
  return parts.length > 0 ? " " + parts.join(", ") : "";
}

/** Get InlineCite[] from citation indices */
function extractCites(
  indices: number[],
  citedSources: CitedSource[],
): InlineCite[] {
  const cites: InlineCite[] = [];
  for (const idx of indices) {
    const src = citedSources.find((s) => s.index === idx);
    if (src?.messageUrl) {
      cites.push({ url: src.messageUrl, channel: src.channel });
    }
  }
  return cites;
}

/** Format inline citations from InlineCite[] (for carry-forward data) */
function inlineCitesFromData(cites: InlineCite[]): string {
  if (cites.length === 0) return "";
  return (
    " " + cites.map((c, i) => `<a href="${c.url}">[${i + 1}]</a>`).join(", ")
  );
}

// Confidence thresholds
const SKIP = 0.6;
const UNCERTAIN = 0.75;
const CERTAIN = 0.95;

function qualDisplay(
  qual: QualCount | null,
  qualNum: number | null,
  conf: number,
): string | null {
  if (qual === null) return null;
  if (qual === "none") return conf >= CERTAIN ? "нет" : null;
  const map: Record<QualCount, string> = {
    all: "все",
    most: "большинство",
    many: "много",
    few: "несколько",
    exists: "есть",
    none: "нет",
    more_than: qualNum != null ? `>${qualNum}` : ">1",
    less_than: qualNum != null ? `<${qualNum}` : "<нескольких",
  };
  return map[qual];
}

function breakdownItem(
  label: string,
  num: number | null,
  qual: QualCount | null,
  qualNum: number | null,
  conf: number,
): string | null {
  if (conf < SKIP) return null;
  const u = conf < UNCERTAIN ? " (?)" : "";
  if (num !== null) return `${label} — ${num}${u}`;
  const qs = qualDisplay(qual, qualNum, conf);
  if (qs === null) return null;
  return `${label} — ${qs}${u}`;
}

/**
 * Build enrichment data from current vote + previous enrichment (carry-forward).
 * Returns updated EnrichmentData for Redis persistence.
 */
function buildEnrichmentFromVote(
  r: VotedResult,
  prev: EnrichmentData,
  alertType: AlertType,
  alertTs: number,
): EnrichmentData {
  const data: EnrichmentData = { ...prev };

  // Origin — update if voted has it
  if (r.country_origins && r.country_origins.length > 0) {
    data.origin = r.country_origins
      .map((c) => COUNTRY_RU[c.name] ?? c.name)
      .join(" + ");
    data.originCites = r.country_origins.flatMap((c) =>
      extractCites(c.citations, r.citedSources),
    );
  }

  // ETA — only for early_warning/siren
  if (
    r.eta_refined_minutes !== null &&
    (alertType === "early_warning" || alertType === "siren")
  ) {
    const absTime = new Date(
      alertTs + r.eta_refined_minutes * 60_000,
    ).toLocaleTimeString("he-IL", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jerusalem",
    });
    data.etaAbsolute = `~${absTime}`;
    data.etaCites = extractCites(r.eta_citations, r.citedSources);
  }

  // Rocket count
  if (r.rocket_count_min !== null && r.rocket_count_max !== null) {
    const u = r.rocket_confidence < UNCERTAIN ? " (?)" : "";
    data.rocketCount =
      r.rocket_count_min === r.rocket_count_max
        ? `${r.rocket_count_min}${u}`
        : `~${r.rocket_count_min}–${r.rocket_count_max}${u}`;
    data.rocketCites = extractCites(r.rocket_citations, r.citedSources);
  }

  // Cassette
  if (r.is_cassette !== null && r.is_cassette_confidence >= SKIP) {
    data.isCassette = r.is_cassette;
  }

  // Intercepted
  if (r.intercepted !== null && r.intercepted_confidence >= SKIP) {
    const u = r.intercepted_confidence < UNCERTAIN ? " (?)" : "";
    data.intercepted = `${r.intercepted}${u}`;
    data.interceptedCites = extractCites(
      r.citedSources
        .filter((s) => {
          const ext = r.citedSources.find((cs) => cs.index === s.index);
          return ext !== undefined;
        })
        .map((s) => s.index),
      r.citedSources,
    );
  } else if (r.intercepted_qual !== null && r.intercepted_confidence >= SKIP) {
    const qs = qualDisplay(
      r.intercepted_qual,
      r.intercepted_qual_num,
      r.intercepted_confidence,
    );
    if (qs) data.intercepted = qs;
  }

  // Hits
  if (
    r.hits_confirmed !== null &&
    r.hits_confirmed > 0 &&
    r.hits_confidence >= SKIP
  ) {
    const u = r.hits_confidence < UNCERTAIN ? " (?)" : "";
    data.hitsConfirmed = `${r.hits_confirmed}${u}`;
    data.hitsCites = extractCites(r.hits_citations, r.citedSources);
  }

  // Casualties
  if (
    r.casualties !== null &&
    r.casualties > 0 &&
    r.casualties_confidence >= SKIP
  ) {
    const u = r.casualties_confidence < UNCERTAIN ? " (?)" : "";
    data.casualties = `${r.casualties}${u}`;
    data.casualtiesCites = extractCites(r.casualties_citations, r.citedSources);
  }

  // Injuries
  if (r.injuries !== null && r.injuries > 0 && r.injuries_confidence >= SKIP) {
    const u = r.injuries_confidence < UNCERTAIN ? " (?)" : "";
    data.injuries = `${r.injuries}${u}`;
    data.injuriesCites = extractCites(r.injuries_citations, r.citedSources);
  }

  // Early warning time — record when first early_warning was received
  if (alertType === "early_warning" && !data.earlyWarningTime) {
    data.earlyWarningTime = toIsraelTime(alertTs);
  }

  return data;
}

/**
 * Build the enriched message text from current message + enrichment data.
 * Uses inline [[1]](url) citations. No superscripts. No footer sources.
 */
function buildEnrichedMessage(
  currentText: string,
  alertType: AlertType,
  alertTs: number,
  enrichment: EnrichmentData,
): string {
  let text = currentText;

  // ── Refine ETA in-place ──
  if (
    enrichment.etaAbsolute &&
    (alertType === "early_warning" || alertType === "siren")
  ) {
    const etaCiteStr = inlineCitesFromData(enrichment.etaCites);
    const refined = `${enrichment.etaAbsolute}${etaCiteStr}`;

    const etaPatterns = [
      /~\d+[–-]\d+\s*мин/, // ~5–12 мин
      /~\d+[–-]\d+\s*min/, // ~5–12 min
      /~\d+[–-]\d+\s*דקות/, // ~5–12 דקות
      /~\d+[–-]\d+\s*دقيقة/, // ~5–12 دقيقة
      /1\.5\s*мин/, // 1.5 мин (siren)
      /1\.5\s*min/,
      /1\.5\s*דקות/,
      /1\.5\s*دقيقة/,
    ];

    for (const pattern of etaPatterns) {
      if (pattern.test(text)) {
        text = text.replace(pattern, refined);
        break;
      }
    }
  }

  // ── Siren: show "Раннее предупреждение: было в HH:MM" ──
  if (alertType === "siren" && enrichment.earlyWarningTime) {
    text = insertBeforeTimeLine(
      text,
      `<b>Раннее предупреждение:</b> было в ${enrichment.earlyWarningTime}`,
    );
  }

  // ── Origin ──
  if (enrichment.origin) {
    const citeStr = inlineCitesFromData(enrichment.originCites);
    text = insertBeforeTimeLine(
      text,
      `\n<b>Откуда:</b> ${enrichment.origin}${citeStr}`,
    );
  }

  // ── Rocket count + breakdown ──
  if (enrichment.rocketCount) {
    const citeStr = inlineCitesFromData(enrichment.rocketCites);
    const cassette = enrichment.isCassette ? ", есть кассетные" : "";

    let breakdown = "";
    const bParts: string[] = [];
    if (enrichment.intercepted) {
      bParts.push(`перехвачено — ${enrichment.intercepted}`);
    }
    if (enrichment.seaImpact) {
      bParts.push(`упали в море — ${enrichment.seaImpact}`);
    }
    if (enrichment.openAreaImpact) {
      bParts.push(`открытая местность — ${enrichment.openAreaImpact}`);
    }
    if (bParts.length > 0) breakdown = `, из них: ${bParts.join(", ")}`;

    text = insertBeforeTimeLine(
      text,
      `<b>Ракет:</b> ${enrichment.rocketCount}${breakdown}${cassette}${citeStr}`,
    );
  } else if (enrichment.intercepted && alertType !== "early_warning") {
    // No rocket count but have interception data
    const citeStr = inlineCitesFromData(enrichment.interceptedCites);
    text = insertBeforeTimeLine(
      text,
      `<b>Перехвачено:</b> ${enrichment.intercepted}${citeStr}`,
    );
  }

  // ── Hits ──
  if (enrichment.hitsConfirmed && alertType !== "early_warning") {
    const areaLabel = Object.values(config.agent.areaLabels)[0] ?? "район";
    const citeStr = inlineCitesFromData(enrichment.hitsCites);
    text = insertBeforeTimeLine(
      text,
      `<b>Попадания (${areaLabel}):</b> ${enrichment.hitsConfirmed}${citeStr}`,
    );
  }

  // ── Casualties / Injuries (resolved only) ──
  if (enrichment.casualties && alertType === "resolved") {
    const citeStr = inlineCitesFromData(enrichment.casualtiesCites);
    text = insertBeforeTimeLine(
      text,
      `<b>Погибшие:</b> ${enrichment.casualties}${citeStr}`,
    );
  }
  if (enrichment.injuries && alertType === "resolved") {
    const citeStr = inlineCitesFromData(enrichment.injuriesCites);
    text = insertBeforeTimeLine(
      text,
      `<b>Пострадавшие:</b> ${enrichment.injuries}${citeStr}`,
    );
  }

  return text;
}

/**
 * Insert a line before the time line (last "Время" / "Time" / "שעת" line).
 */
function insertBeforeTimeLine(text: string, line: string): string {
  const timePattern =
    /(<b>(?:Время оповещения|Alert time|שעת ההתרעה|وقت الإنذار):<\/b>)/;
  const match = text.match(timePattern);
  if (match?.index !== undefined) {
    return text.slice(0, match.index) + line + "\n" + text.slice(match.index);
  }
  const lines = text.split("\n");
  lines.splice(Math.max(lines.length - 1, 0), 0, line);
  return lines.join("\n");
}

async function editMessage(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const { votedResult } = state;

  if (!config.botToken) return {};

  const tgBot = new Bot(config.botToken);

  // No valid sources — carry forward previous data only
  const prevEnrichment = state.previousEnrichment ?? emptyEnrichmentData();

  if (!votedResult) {
    // No new data from channels — still try to build message from carry-forward
    if (prevEnrichment.origin || prevEnrichment.intercepted) {
      // Have carry-forward data, build message
      const newText = buildEnrichedMessage(
        state.currentText,
        state.alertType,
        state.alertTs,
        prevEnrichment,
      );

      const hash = textHash(newText);
      if (hash === prevEnrichment.lastEditHash) {
        logger.info("Agent: no change in message (dedup) — skipping edit", {
          alertId: state.alertId,
        });
        return {};
      }

      try {
        if (state.isCaption) {
          await tgBot.api.editMessageCaption(state.chatId, state.messageId, {
            caption: newText,
            parse_mode: "HTML",
          });
        } else {
          await tgBot.api.editMessageText(
            state.chatId,
            state.messageId,
            newText,
            { parse_mode: "HTML" },
          );
        }

        prevEnrichment.lastEditHash = hash;
        await saveEnrichmentData(prevEnrichment);

        logger.info("Agent: message enriched (carry-forward only)", {
          alertId: state.alertId,
          messageId: state.messageId,
        });
      } catch (err) {
        const errStr = String(err);
        if (errStr.includes("message is not modified")) {
          prevEnrichment.lastEditHash = hash;
          await saveEnrichmentData(prevEnrichment);
          logger.info("Agent: message already up-to-date (dedup)", {
            alertId: state.alertId,
          });
        } else {
          logger.error("Agent: failed to edit message", {
            alertId: state.alertId,
            error: errStr,
          });
        }
      }
    } else {
      logger.info("Agent: no voted result — skipping edit", {
        alertId: state.alertId,
      });
    }
    return {};
  }

  // Build enrichment data: merge vote + previous
  const enrichment = buildEnrichmentFromVote(
    votedResult,
    prevEnrichment,
    state.alertType,
    state.alertTs,
  );

  const newText = buildEnrichedMessage(
    state.currentText,
    state.alertType,
    state.alertTs,
    enrichment,
  );

  // Dedup: skip if text hasn't changed
  const hash = textHash(newText);
  if (hash === enrichment.lastEditHash) {
    logger.info("Agent: no change in message (dedup) — skipping edit", {
      alertId: state.alertId,
    });
    return {};
  }

  // Low confidence: log but still show data with (?) markers
  if (votedResult.confidence < config.agent.confidenceThreshold) {
    logger.info(
      "Agent: confidence below threshold — editing with (?) markers",
      {
        alertId: state.alertId,
        confidence: votedResult.confidence,
        threshold: config.agent.confidenceThreshold,
      },
    );
  }

  try {
    if (state.isCaption) {
      await tgBot.api.editMessageCaption(state.chatId, state.messageId, {
        caption: newText,
        parse_mode: "HTML",
      });
    } else {
      await tgBot.api.editMessageText(state.chatId, state.messageId, newText, {
        parse_mode: "HTML",
      });
    }

    enrichment.lastEditHash = hash;
    await saveEnrichmentData(enrichment);

    logger.info("Agent: message enriched", {
      alertId: state.alertId,
      messageId: state.messageId,
      confidence: votedResult.confidence,
      sources: votedResult.sources_count,
      phase: state.alertType,
    });
  } catch (err) {
    const errStr = String(err);
    if (errStr.includes("message is not modified")) {
      enrichment.lastEditHash = hash;
      await saveEnrichmentData(enrichment);
      logger.info("Agent: message already up-to-date (dedup)", {
        alertId: state.alertId,
      });
    } else {
      logger.error("Agent: failed to edit message", {
        alertId: state.alertId,
        error: errStr,
      });
    }
  }

  return {};
}

// ─────────────────────────────────────────────────────────
// Clarify Node — MCP tool calling via ReAct (conditional)
// ─────────────────────────────────────────────────────────

async function clarifyNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const {
    votedResult,
    extractions,
    alertId,
    alertAreas,
    alertType,
    alertTs,
    messageId,
    currentText,
  } = state;

  if (!votedResult) {
    logger.info("Agent: clarify skipped — no voted result", { alertId });
    return { clarifyAttempted: true };
  }

  logger.info("Agent: clarify triggered", {
    alertId,
    confidence: votedResult.confidence,
    threshold: config.agent.confidenceThreshold,
    phase: alertType,
  });

  try {
    const result = await runClarify({
      alertId,
      alertAreas,
      alertType,
      alertTs,
      messageId,
      currentText,
      extractions,
      votedResult,
    });

    const mergedExtractions = [...extractions, ...result.newExtractions];

    logger.info("Agent: clarify completed", {
      alertId,
      toolCalls: result.toolCallCount,
      clarified: result.clarified,
      newExtractions: result.newExtractions.length,
      newPosts: result.newPosts.length,
    });

    return {
      extractions: mergedExtractions,
      votedResult: null,
      clarifyAttempted: true,
    };
  } catch (err) {
    logger.error("Agent: clarify failed", {
      alertId,
      error: String(err),
    });
    return { clarifyAttempted: true };
  }
}

// ── Conditional routing after vote ─────────────────────

function shouldClarify(state: AgentStateType): "clarify" | "editMessage" {
  if (state.clarifyAttempted) return "editMessage";
  if (!config.agent.mcpTools) return "editMessage";
  if (!state.votedResult) return "editMessage";

  // Low confidence → clarify (may use Oref tool for time validation)
  if (state.votedResult.confidence < config.agent.confidenceThreshold) {
    logger.info("Agent: routing to clarify (low confidence)", {
      confidence: state.votedResult.confidence,
      threshold: config.agent.confidenceThreshold,
    });
    return "clarify";
  }

  // Suspicious time: if the only country is unexpected for the region, verify
  // This catches cases like "Lebanon" appearing on a Tel Aviv alert
  // when the real attack is from Iran/Yemen
  const origins = state.votedResult.country_origins;
  if (
    origins &&
    origins.length === 1 &&
    state.votedResult.sources_count === 1
  ) {
    const singleOrigin = origins[0]!.name;
    // Lebanon attacks typically don't reach central Israel
    if (
      singleOrigin === "Lebanon" &&
      state.alertAreas.some(
        (a) =>
          a.includes("תל אביב") ||
          a.includes("גוש דן") ||
          a.includes("שרון") ||
          a.includes("מרכז"),
      )
    ) {
      logger.info(
        "Agent: routing to clarify (suspicious single source: Lebanon for central Israel)",
        { origin: singleOrigin },
      );
      return "clarify";
    }
  }

  return "editMessage";
}

// ── Build graph ────────────────────────────────────────

const checkpointer = new MemorySaver();

function buildGraph() {
  const graph = new StateGraph(AgentState)
    .addNode("collectAndPreFilter", collectAndPreFilter)
    .addNode("extractAndValidate", extractAndValidate)
    .addNode("postFilter", postFilter)
    .addNode("vote", vote)
    .addNode("clarify", clarifyNode)
    .addNode("revote", vote)
    .addNode("editMessage", editMessage)
    .addEdge("__start__", "collectAndPreFilter")
    .addEdge("collectAndPreFilter", "extractAndValidate")
    .addEdge("extractAndValidate", "postFilter")
    .addEdge("postFilter", "vote")
    .addConditionalEdges("vote", shouldClarify, {
      clarify: "clarify",
      editMessage: "editMessage",
    })
    .addEdge("clarify", "revote")
    .addEdge("revote", "editMessage")
    .addEdge("editMessage", "__end__");

  return graph.compile({ checkpointer });
}

// ── Public API ─────────────────────────────────────────

export interface RunEnrichmentInput {
  alertId: string;
  alertTs: number;
  alertType: AlertType;
  alertAreas: string[];
  chatId: string;
  messageId: number;
  isCaption: boolean;
  currentText: string;
}

export async function runEnrichment(input: RunEnrichmentInput): Promise<void> {
  const app = buildGraph();

  await app.invoke(
    {
      alertId: input.alertId,
      alertTs: input.alertTs,
      alertType: input.alertType,
      alertAreas: input.alertAreas,
      chatId: input.chatId,
      messageId: input.messageId,
      isCaption: input.isCaption,
      currentText: input.currentText,
      channelPosts: [],
      filteredPosts: [],
      extractions: [],
      votedResult: null,
      clarifyAttempted: false,
      previousEnrichment: emptyEnrichmentData(),
      sessionStartTs: 0,
      phaseStartTs: 0,
    },
    { configurable: { thread_id: input.alertId } },
  );
}

// ── Exported for testing ───────────────────────────────

export const _test = {
  getLLM,
  buildRegionKeywords,
  LAUNCH_KEYWORDS,
  TIME_WINDOW_MS,
  toIsraelTime,
  textHash,
  postFilter,
  vote,
  buildEnrichmentFromVote,
  buildEnrichedMessage,
  insertBeforeTimeLine,
  inlineCites,
  inlineCitesFromData,
  extractCites,
  COUNTRY_RU,
  SYSTEM_PROMPT_BASE,
  getPhaseInstructions,
  SKIP,
  UNCERTAIN,
  CERTAIN,
} as const;
