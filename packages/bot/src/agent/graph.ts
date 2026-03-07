/**
 * LangGraph.js enrichment pipeline — tiered validation.
 *
 * Design: minimize tokens, maximize confidence.
 *
 * ┌──────────────────────────────────────────────────────────────┐
 * │ Tier 0: preFilter       (deterministic, 0 tokens)           │
 * │   → keyword + region check on raw post text                 │
 * │                                                              │
 * │ Tier 1: extractAndValidate  (1 LLM call per post)           │
 * │   → combined extraction + 3 validators in single JSON:      │
 * │     V1: region_relevance  (is post about our area?)         │
 * │     V2: source_trust      (factual vs rumor/panic?)         │
 * │     V3: tone              (calm/neutral/alarmist?)          │
 * │   → structured output, all validation in one prompt         │
 * │                                                              │
 * │ Tier 2: postFilter      (deterministic, 0 tokens)           │
 * │   → reject: region_relevance < 0.5                          │
 * │   → reject: source_trust < 0.4                              │
 * │   → reject: tone === "alarmist"                             │
 * │   → reject: all data fields null                            │
 * │                                                              │
 * │ Tier 3: vote            (deterministic, 0 tokens)           │
 * │   → majority consensus across validated sources             │
 * │                                                              │
 * │ Tier 4: editMessage     (deterministic, 0 tokens)           │
 * │   → inline update of existing key:value pairs               │
 * └──────────────────────────────────────────────────────────────┘
 *
 * Total LLM cost: 1 call × N posts (max 8). GPT-4o-mini ≈ $0.0001/post.
 */

import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { Annotation, StateGraph } from "@langchain/langgraph";
import { Bot } from "grammy";
import { config } from "../config.js";
import * as logger from "../logger.js";
import type { ChannelPost } from "./store.js";
import { getChannelPosts } from "./store.js";
import type {
  AlertType,
  CitedSource,
  ExtractionResult,
  ValidatedExtraction,
  VotedResult,
} from "./types.js";

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
});

type AgentStateType = typeof AgentState.State;

// ── LLM ───────────────────────────────────────────────

function getLLM(): ChatGoogleGenerativeAI {
  return new ChatGoogleGenerativeAI({
    model: config.agent.googleModel,
    apiKey: config.agent.googleApiKey,
    temperature: 0,
    maxOutputTokens: 400,
  });
}

// ── Region keywords (Hebrew + transliterations) ────────

/**
 * Build keyword list from config areas + area_labels.
 * Returns lowercased keywords for matching.
 */
function buildRegionKeywords(): string[] {
  const keywords: string[] = [];

  for (const area of config.areas) {
    keywords.push(area.toLowerCase());
    // First word often enough (e.g. "תל אביב" → "תל")
    const first = area.split(" ")[0];
    if (first && first.length >= 2) keywords.push(first.toLowerCase());
  }

  for (const [he, label] of Object.entries(config.agent.areaLabels)) {
    keywords.push(he.toLowerCase());
    // Add transliterated label words (e.g. "Дан центр" → "дан", "центр")
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
    "жд",
    "перехват",
    "intercept",
    "siren",
    "азака",
    "צבע אדום",
    "red alert",
  );

  return [...new Set(keywords)];
}

// ─────────────────────────────────────────────────────────
// Tier 0: Pre-filter (deterministic, 0 tokens)
// ─────────────────────────────────────────────────────────

async function collectAndPreFilter(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const posts = await getChannelPosts(state.alertId);
  const windowMs = config.agent.windowMinutes * 60 * 1000;
  const inWindow = posts.filter(
    (p) => Math.abs(p.ts - state.alertTs) <= windowMs,
  );

  if (inWindow.length === 0) {
    logger.info("Agent: no posts in window", { alertId: state.alertId });
    return { channelPosts: inWindow, filteredPosts: [] };
  }

  const keywords = buildRegionKeywords();

  const filtered = inWindow.filter((post) => {
    const text = post.text.toLowerCase();
    // Must contain at least 1 region/attack keyword
    return keywords.some((kw) => text.includes(kw));
  });

  logger.info("Agent: pre-filter", {
    alertId: state.alertId,
    total: posts.length,
    in_window: inWindow.length,
    after_keyword_filter: filtered.length,
  });

  return { channelPosts: inWindow, filteredPosts: filtered };
}

// ─────────────────────────────────────────────────────────
// Tier 1: Extract + validate (1 LLM call per post)
// ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You analyze Telegram channel messages about a missile/rocket attack on Israel.
Your job: extract factual data AND assess message quality. Be concise.

Return ONLY valid JSON (no markdown, no explanation):
{
  "region_relevance": float,       // 0–1: does this message discuss the specified alert region?
  "source_trust": float,           // 0–1: factual reporting (1.0) vs unverified rumors/panic (0.0)
  "tone": "calm"|"neutral"|"alarmist",  // message tone — reject alarmist content
  "country_origin": string|null,   // "Iran","Yemen","Lebanon","Gaza","Iraq" or null
  "rocket_count": int|null,        // total rockets/missiles if mentioned
  "is_cassette": bool|null,        // cluster/cassette munitions?
  "hits_confirmed": int|null,      // confirmed hits/impacts
  "eta_refined_minutes": int|null, // refined time-to-impact if mentioned
  "confidence": float              // 0–1: overall confidence in this extraction
}

Rules:
- If unrelated to the alert region, set region_relevance=0 and all data fields to null.
- If message is speculative/unconfirmed rumor, set source_trust < 0.4.
- If message uses excessive caps, exclamation marks, panic language → tone="alarmist".
- Only extract concrete numbers from the text. Don't guess.`;

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

  const results = await Promise.all(
    posts.map(async (post): Promise<ValidatedExtraction> => {
      try {
        const response = await llm.invoke([
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Alert region: ${regionHint}\nChannel: ${
              post.channel
            }\n\nMessage:\n${post.text.slice(0, 800)}`,
          },
        ]);

        const text =
          typeof response.content === "string"
            ? response.content
            : JSON.stringify(response.content);

        const parsed = JSON.parse(text.trim()) as ExtractionResult;
        return {
          ...parsed,
          channel: post.channel,
          messageUrl: post.messageUrl,
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
          country_origin: null,
          rocket_count: null,
          is_cassette: null,
          hits_confirmed: null,
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
  });

  return { extractions: results };
}

// ─────────────────────────────────────────────────────────
// Tier 2: Post-filter (deterministic, 0 tokens)
// ─────────────────────────────────────────────────────────

function postFilter(state: AgentStateType): Partial<AgentStateType> {
  const validated = state.extractions.map((ext): ValidatedExtraction => {
    // V1: region relevance
    if (ext.region_relevance < 0.5) {
      return { ...ext, valid: false, reject_reason: "region_irrelevant" };
    }
    // V2: source trust
    if (ext.source_trust < 0.4) {
      return { ...ext, valid: false, reject_reason: "untrusted_source" };
    }
    // V3: tone — reject alarmist (бот для успокоения, не для паники)
    if (ext.tone === "alarmist") {
      return { ...ext, valid: false, reject_reason: "alarmist_tone" };
    }
    // V4: at least one data field must be non-null
    const hasData =
      ext.country_origin !== null ||
      ext.rocket_count !== null ||
      ext.is_cassette !== null ||
      ext.hits_confirmed !== null ||
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

  // Assign 1-based citation indices to valid extractions
  const indexed = valid.map((e, i) => ({ ...e, idx: i + 1 }));

  // All valid sources become cited sources
  const citedSources: CitedSource[] = indexed.map((e) => ({
    index: e.idx,
    channel: e.channel,
    messageUrl: e.messageUrl ?? null,
  }));

  // ETA: highest confidence source that has eta
  const withEta = indexed
    .filter((e) => e.eta_refined_minutes !== null)
    .sort((a, b) => b.confidence - a.confidence);
  const bestEta = withEta[0] ?? null;

  // Country: group unique values, each with their source indices
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

  // Rocket count: range across sources (min … max)
  const rocketSrcs = indexed.filter((e) => e.rocket_count !== null);
  const rocketVals = rocketSrcs.map((e) => e.rocket_count as number);
  const rocket_count_min =
    rocketVals.length > 0 ? Math.min(...rocketVals) : null;
  const rocket_count_max =
    rocketVals.length > 0 ? Math.max(...rocketVals) : null;
  const rocket_citations = rocketSrcs.map((e) => e.idx);

  // Cassette: majority
  const cassVals = indexed
    .filter((e) => e.is_cassette !== null)
    .map((e) => e.is_cassette as boolean);
  const is_cassette =
    cassVals.length > 0
      ? cassVals.filter(Boolean).length > cassVals.length / 2
      : null;

  // Hits: median
  const hitsVals = indexed
    .filter((e) => e.hits_confirmed !== null)
    .map((e) => e.hits_confirmed as number)
    .sort((a, b) => a - b);
  const hits_confirmed =
    hitsVals.length > 0 ? hitsVals[Math.floor(hitsVals.length / 2)] : null;

  // Weighted confidence: source_trust × confidence
  const totalWeight = indexed.reduce(
    (s, e) => s + e.source_trust * e.confidence,
    0,
  );
  const weightedConf = totalWeight / indexed.length;

  // Hits citations: sources that reported confirmed hits
  const hitsSrcs = indexed.filter(
    (e) => e.hits_confirmed !== null && e.hits_confirmed > 0,
  );
  const hits_citations = hitsSrcs.map((e) => e.idx);

  const voted: VotedResult = {
    eta_refined_minutes: bestEta?.eta_refined_minutes ?? null,
    eta_citations: bestEta ? [bestEta.idx] : [],
    country_origins,
    rocket_count_min,
    rocket_count_max,
    is_cassette,
    rocket_citations,
    hits_confirmed,
    hits_citations,
    confidence: Math.round(weightedConf * 100) / 100,
    sources_count: indexed.length,
    citedSources,
  };

  logger.info("Agent: voted", { alertId: state.alertId, voted });
  return { votedResult: voted };
}

// ─────────────────────────────────────────────────────────
// Tier 4: Edit message — inline update (0 tokens)
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

/** Convert index to Unicode superscript string: 1 → ¹, 13 → ¹³ */
const SUPERSCRIPTS = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"];
function sup(indices: number[]): string {
  return indices
    .map((n) =>
      String(n)
        .split("")
        .map((d) => SUPERSCRIPTS[Number(d)])
        .join(""),
    )
    .join("");
}

/**
 * Merge enrichment data INTO the existing key:value message.
 * Format:
 *   Подлётное время: ~00:21¹          ← ETA as absolute clock time
 *
 *   Откуда: Иран¹³ + Ливан²           ← blank line before intel block
 *   Ракет: ~5-7
 *   Попадания (Дан центр): 2¹
 *   Время оповещения: 03:47
 *   —
 *   Источники: [1](url) [2](url) [3](url)
 */
function buildEnrichedMessage(
  currentText: string,
  alertType: AlertType,
  alertTs: number,
  r: VotedResult,
): string {
  let text = currentText;

  // Refine ETA in-place (early/siren only)
  if (
    r.eta_refined_minutes !== null &&
    r.eta_citations.length > 0 &&
    (alertType === "early_warning" || alertType === "siren")
  ) {
    text = refineEtaInPlace(
      text,
      r.eta_refined_minutes,
      alertTs,
      r.eta_citations,
    );
  }

  // Insert "Откуда" before time line (with leading blank line for visual separation)
  if (r.country_origins && r.country_origins.length > 0) {
    const parts = r.country_origins.map((c) => {
      const ru = COUNTRY_RU[c.name] ?? c.name;
      return `${ru}${sup(c.citations)}`;
    });
    text = insertBeforeTimeLine(text, `\n<b>Откуда:</b> ${parts.join(" + ")}`);
  }

  // Insert "Ракет" before time line (no inline citations — sources footer has them)
  if (r.rocket_count_min !== null && r.rocket_count_max !== null) {
    const countStr =
      r.rocket_count_min === r.rocket_count_max
        ? `${r.rocket_count_min}`
        : `~${r.rocket_count_min}-${r.rocket_count_max}`;
    const cassette = r.is_cassette ? " (кассет.)" : "";
    text = insertBeforeTimeLine(text, `<b>Ракет:</b> ${countStr}${cassette}`);
  }

  // Insert "Попадания" before time line (only if > 0, with citation)
  if (r.hits_confirmed !== null && r.hits_confirmed > 0) {
    const areaLabel = Object.values(config.agent.areaLabels)[0] ?? "район";
    const hitsCite = r.hits_citations.length > 0 ? sup(r.hits_citations) : "";
    text = insertBeforeTimeLine(
      text,
      `<b>Попадания (${areaLabel}):</b> ${r.hits_confirmed}${hitsCite}`,
    );
  }

  // Sources footer: [1](url)   [2](url)   ...
  const sourcesWithUrl = r.citedSources.filter((s) => s.messageUrl);
  if (sourcesWithUrl.length > 0) {
    const links = sourcesWithUrl
      .map((s) => `<a href="${s.messageUrl}">[${s.index}]</a>`)
      .join("  ");
    text += `\n—\n<i>Источники: ${links}</i>`;
  }

  return text;
}

/**
 * Insert a line before the time line (last "Время" / "Time" / "שעת" line).
 * This keeps new data visually grouped with existing fields.
 */
function insertBeforeTimeLine(text: string, line: string): string {
  // Match "Время оповещения" / "Alert time" / "שעת ההתרעה" / "وقت الإنذار"
  const timePattern =
    /(<b>(?:Время оповещения|Alert time|שעת ההתרעה|وقت الإنذار):<\/b>)/;
  const match = text.match(timePattern);
  if (match?.index !== undefined) {
    return text.slice(0, match.index) + line + "\n" + text.slice(match.index);
  }
  // Fallback: append before last line
  const lines = text.split("\n");
  lines.splice(Math.max(lines.length - 1, 0), 0, line);
  return lines.join("\n");
}

/**
 * Replace the default ETA range with absolute impact time + superscript citation.
 * "~5–12 мин" → "~00:21¹"
 */
function refineEtaInPlace(
  text: string,
  minutes: number,
  alertTs: number,
  citations: number[],
): string {
  // Compute absolute impact time in Israel timezone
  const absTime = new Date(alertTs + minutes * 60_000).toLocaleTimeString(
    "he-IL",
    { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem" },
  );
  const refined = `~${absTime}${sup(citations)}`;

  const etaPatterns = [
    /~\d+[–-]\d+\s*мин/, // ~5–12 мин
    /~\d+[–-]\d+\s*min/, // ~5–12 min
    /~\d+[–-]\d+\s*דקות/, // ~5–12 דקות
    /~\d+[–-]\d+\s*دقائق/, // ~5–12 دقائق
    /1\.5\s*мин/, // 1.5 мин (siren)
    /1\.5\s*min/, // 1.5 min
    /1\.5\s*דקות/, // 1.5 דקות
    /1\.5\s*دقائق/, // 1.5 دقائق
  ];

  for (const pattern of etaPatterns) {
    if (pattern.test(text)) {
      return text.replace(pattern, refined);
    }
  }

  return text;
}

async function editMessage(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const { votedResult } = state;

  if (
    !votedResult ||
    votedResult.confidence < config.agent.confidenceThreshold
  ) {
    logger.info("Agent: confidence below threshold — not editing", {
      alertId: state.alertId,
      confidence: votedResult?.confidence ?? 0,
      threshold: config.agent.confidenceThreshold,
    });
    return {};
  }

  if (!config.botToken) return {};

  const newText = buildEnrichedMessage(
    state.currentText,
    state.alertType,
    state.alertTs,
    votedResult,
  );

  const tgBot = new Bot(config.botToken);

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
    logger.info("Agent: message enriched", {
      alertId: state.alertId,
      messageId: state.messageId,
      confidence: votedResult.confidence,
      sources: votedResult.sources_count,
    });
  } catch (err) {
    logger.error("Agent: failed to edit message", {
      alertId: state.alertId,
      error: String(err),
    });
  }

  return {};
}

// ── Build graph ────────────────────────────────────────

function buildGraph() {
  const graph = new StateGraph(AgentState)
    .addNode("collectAndPreFilter", collectAndPreFilter)
    .addNode("extractAndValidate", extractAndValidate)
    .addNode("postFilter", postFilter)
    .addNode("vote", vote)
    .addNode("editMessage", editMessage)
    .addEdge("__start__", "collectAndPreFilter")
    .addEdge("collectAndPreFilter", "extractAndValidate")
    .addEdge("extractAndValidate", "postFilter")
    .addEdge("postFilter", "vote")
    .addEdge("vote", "editMessage")
    .addEdge("editMessage", "__end__");

  return graph.compile();
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

  await app.invoke({
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
  });
}
