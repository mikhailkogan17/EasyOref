/**
 * Message building and Telegram editing.
 *
 * Builds enriched message text from voted consensus + carry-forward data.
 * Uses inline [[1]](url) citations. No superscripts. No footer sources.
 */

import { Bot } from "grammy";
import { config } from "../config.js";
import * as logger from "../logger.js";
import { textHash, toIsraelTime } from "./helpers.js";
import {
  getActiveSession,
  saveEnrichmentData,
  setActiveSession,
} from "./store.js";
import type {
  AlertType,
  CitedSource,
  EnrichmentData,
  InlineCite,
  QualCount,
  VotedResult,
} from "./types.js";
import { emptyEnrichmentData } from "./types.js";

// ── Country translations ───────────────────────────────

/** EN country name → Russian */
export const COUNTRY_RU: Record<string, string> = {
  Iran: "Иран",
  Yemen: "Йемен",
  Lebanon: "Ливан",
  Gaza: "Газа",
  Iraq: "Ирак",
  Syria: "Сирия",
  Hezbollah: "Хезболла",
};

// ── Citation helpers ───────────────────────────────────

/** Format inline citations: [[1]](url), [[2]](url) */
export function inlineCites(
  indices: number[],
  citedSources: CitedSource[],
): string {
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
export function extractCites(
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

/** Format inline citations from InlineCite[] (carry-forward data) */
export function inlineCitesFromData(cites: InlineCite[]): string {
  if (cites.length === 0) return "";
  return (
    " " + cites.map((c, i) => `<a href="${c.url}">[${i + 1}]</a>`).join(", ")
  );
}

/**
 * Build a global URL→index map across ALL enrichment fields.
 * Deduplicates by URL so the same source gets the same [N] everywhere.
 */
export function buildGlobalCiteMap(
  enrichment: EnrichmentData,
): Map<string, number> {
  const allCites: InlineCite[] = [
    ...enrichment.originCites,
    ...enrichment.etaCites,
    ...enrichment.rocketCites,
    ...enrichment.interceptedCites,
    ...enrichment.hitsCites,
    ...enrichment.noImpactsCites,
    ...enrichment.casualtiesCites,
    ...enrichment.injuriesCites,
  ];
  const map = new Map<string, number>();
  let idx = 1;
  for (const cite of allCites) {
    if (!map.has(cite.url)) {
      map.set(cite.url, idx++);
    }
  }
  return map;
}

/** Format inline citations using global numbering */
export function renderCitesGlobal(
  cites: InlineCite[],
  globalMap: Map<string, number>,
): string {
  if (cites.length === 0) return "";
  const parts: string[] = [];
  for (const c of cites) {
    const i = globalMap.get(c.url);
    if (i !== undefined) {
      parts.push(`<a href="${c.url}">[${i}]</a>`);
    }
  }
  return parts.length > 0 ? " " + parts.join(", ") : "";
}

// ── Confidence thresholds ──────────────────────────────

export const SKIP = 0.6;
export const UNCERTAIN = 0.75;
export const CERTAIN = 0.95;

// ── Monitoring indicator ───────────────────────────────

/** Strip "⏳ ..." monitoring line from message text */
export const MONITORING_RE = /\n?⏳\s*[^\n]+$/;

export function stripMonitoring(text: string): string {
  return text.replace(MONITORING_RE, "");
}

export function appendMonitoring(text: string, label: string): string {
  return text + "\n" + label;
}

// ── Display helpers ────────────────────────────────────

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

// ── Build enrichment data from vote ────────────────────

/**
 * Build enrichment data from current vote + previous enrichment (carry-forward).
 * Returns updated EnrichmentData for Redis persistence.
 */
export function buildEnrichmentFromVote(
  r: VotedResult,
  prev: EnrichmentData,
  alertType: AlertType,
  alertTs: number,
): EnrichmentData {
  const data: EnrichmentData = { ...prev };

  // Origin
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
      r.intercepted_citations,
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

  // No impacts: sources explicitly confirm zero hits
  if (r.no_impacts && r.hits_confidence >= SKIP) {
    data.noImpacts = true;
    data.noImpactsCites = extractCites(r.no_impacts_citations, r.citedSources);
  }

  // Rocket detail (per-region breakdown)
  if (r.rocket_detail) {
    data.rocketDetail = r.rocket_detail;
  }

  // Hit location & type
  if (r.hit_location && r.hits_confirmed !== null && r.hits_confirmed > 0) {
    data.hitLocation = r.hit_location;
  }
  if (r.hit_type && r.hits_confirmed !== null && r.hits_confirmed > 0) {
    data.hitType = r.hit_type;
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

  // Early warning time
  if (alertType === "early_warning" && !data.earlyWarningTime) {
    data.earlyWarningTime = toIsraelTime(alertTs);
  }

  return data;
}

// ── Build enriched message text ────────────────────────

/**
 * Build the enriched message text from current message + enrichment data.
 * Uses inline [[1]](url) citations.
 */
export function buildEnrichedMessage(
  currentText: string,
  alertType: AlertType,
  alertTs: number,
  enrichment: EnrichmentData,
  monitoringLabel?: string,
): string {
  // Strip monitoring indicator before building — will re-add at the end
  let text = stripMonitoring(currentText);

  // ── Global citation map ──
  const citeMap = buildGlobalCiteMap(enrichment);

  // ── Refine ETA in-place ──
  if (
    enrichment.etaAbsolute &&
    (alertType === "early_warning" || alertType === "siren")
  ) {
    const etaCiteStr = renderCitesGlobal(enrichment.etaCites, citeMap);
    const refined = `${enrichment.etaAbsolute}${etaCiteStr}`;

    const etaPatterns = [
      /~\d+[–-]\d+\s*мин/,
      /~\d+[–-]\d+\s*min/,
      /~\d+[–-]\d+\s*דקות/,
      /~\d+[–-]\d+\s*دقيقة/,
      /1\.5\s*мин/,
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

  // ── Origin ──
  if (enrichment.origin) {
    const citeStr = renderCitesGlobal(enrichment.originCites, citeMap);
    text = insertBeforeBlockEnd(
      text,
      `<b>Откуда:</b> ${enrichment.origin}${citeStr}`,
    );
  }

  // ── Rocket count (separate line, no compound breakdown) ──
  if (enrichment.rocketCount) {
    const citeStr = renderCitesGlobal(enrichment.rocketCites, citeMap);
    const cassette = enrichment.isCassette ? ", кассетные" : "";
    const detail = enrichment.rocketDetail
      ? ` (${enrichment.rocketDetail})`
      : "";
    text = insertBeforeBlockEnd(
      text,
      `<b>Ракет:</b> ${enrichment.rocketCount}${detail}${cassette}${citeStr}`,
    );
  }

  // ── Intercepted (own line) ──
  if (enrichment.intercepted && alertType !== "early_warning") {
    const citeStr = renderCitesGlobal(enrichment.interceptedCites, citeMap);
    text = insertBeforeBlockEnd(
      text,
      `<b>Перехваты:</b> ${enrichment.intercepted}${citeStr}`,
    );
  }

  // ── Hits / No impacts (own line) ──
  if (enrichment.hitsConfirmed && alertType !== "early_warning") {
    const citeStr = renderCitesGlobal(enrichment.hitsCites, citeMap);
    const HIT_TYPE_DISPLAY: Record<string, string> = {
      direct: "прямое",
      shrapnel: "обломки",
    };
    const qualifiers: string[] = [];
    if (enrichment.hitLocation) qualifiers.push(enrichment.hitLocation);
    if (enrichment.hitType)
      qualifiers.push(
        HIT_TYPE_DISPLAY[enrichment.hitType] ?? enrichment.hitType,
      );
    const suffix = qualifiers.length > 0 ? ` (${qualifiers.join(", ")})` : "";
    text = insertBeforeBlockEnd(
      text,
      `<b>Попадания:</b> ${enrichment.hitsConfirmed}${suffix}${citeStr}`,
    );
  } else if (enrichment.noImpacts && alertType !== "early_warning") {
    const citeStr = renderCitesGlobal(enrichment.noImpactsCites, citeMap);
    text = insertBeforeBlockEnd(text, `<b>Прилетов:</b> нет${citeStr}`);
  }

  // ── Casualties / Injuries (resolved only) ──
  if (enrichment.casualties && alertType === "resolved") {
    const citeStr = renderCitesGlobal(enrichment.casualtiesCites, citeMap);
    text = insertBeforeBlockEnd(
      text,
      `<b>Погибшие:</b> ${enrichment.casualties}${citeStr}`,
    );
  }
  if (enrichment.injuries && alertType === "resolved") {
    const citeStr = renderCitesGlobal(enrichment.injuriesCites, citeMap);
    text = insertBeforeBlockEnd(
      text,
      `<b>Пострадавшие:</b> ${enrichment.injuries}${citeStr}`,
    );
  }

  // Re-add monitoring indicator if still in active phase
  if (monitoringLabel && alertType !== "resolved") {
    text = appendMonitoring(text, monitoringLabel);
  }

  return text;
}

/**
 * Insert a line before </blockquote> (or legacy time line as fallback).
 */
export function insertBeforeBlockEnd(text: string, line: string): string {
  const bqIdx = text.lastIndexOf("</blockquote>");
  if (bqIdx !== -1) {
    return text.slice(0, bqIdx) + line + "\n" + text.slice(bqIdx);
  }
  // Legacy fallback: insert before time line
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

/** @deprecated Use insertBeforeBlockEnd */
export const insertBeforeTimeLine = insertBeforeBlockEnd;

// ── Edit message ───────────────────────────────────────

export interface EditMessageInput {
  alertId: string;
  alertTs: number;
  alertType: AlertType;
  chatId: string;
  messageId: number;
  isCaption: boolean;
  currentText: string;
  votedResult: VotedResult | null;
  previousEnrichment: EnrichmentData;
  monitoringLabel?: string;
}

/**
 * Edit the Telegram message with enriched data.
 */
export async function editMessage(input: EditMessageInput): Promise<void> {
  if (!config.botToken) return;

  const tgBot = new Bot(config.botToken);
  const prev = input.previousEnrichment ?? emptyEnrichmentData();

  if (!input.votedResult) {
    // No new data — try carry-forward only
    if (prev.origin || prev.intercepted) {
      const newText = buildEnrichedMessage(
        input.currentText,
        input.alertType,
        input.alertTs,
        prev,
        input.monitoringLabel,
      );

      const hash = textHash(newText);
      if (hash === prev.lastEditHash) {
        logger.info("Agent: no change (dedup)", { alertId: input.alertId });
        return;
      }

      try {
        if (input.isCaption) {
          await tgBot.api.editMessageCaption(input.chatId, input.messageId, {
            caption: newText,
            parse_mode: "HTML",
          });
        } else {
          await tgBot.api.editMessageText(
            input.chatId,
            input.messageId,
            newText,
            { parse_mode: "HTML" },
          );
        }

        prev.lastEditHash = hash;
        await saveEnrichmentData(prev);

        // Keep session.currentText in sync for monitoring removal
        const sess = await getActiveSession();
        if (sess) {
          sess.currentText = newText;
          await setActiveSession(sess);
        }

        logger.info("Agent: enriched (carry-forward)", {
          alertId: input.alertId,
        });
      } catch (err) {
        const errStr = String(err);
        if (errStr.includes("message is not modified")) {
          prev.lastEditHash = hash;
          await saveEnrichmentData(prev);
        } else {
          logger.error("Agent: edit failed", {
            alertId: input.alertId,
            error: errStr,
          });
        }
      }
    } else {
      logger.info("Agent: no voted result — skipping", {
        alertId: input.alertId,
      });
    }
    return;
  }

  // Build enrichment data: merge vote + previous
  const enrichment = buildEnrichmentFromVote(
    input.votedResult,
    prev,
    input.alertType,
    input.alertTs,
  );

  const newText = buildEnrichedMessage(
    input.currentText,
    input.alertType,
    input.alertTs,
    enrichment,
    input.monitoringLabel,
  );

  // Dedup: skip if text hasn't changed
  const hash = textHash(newText);
  if (hash === enrichment.lastEditHash) {
    logger.info("Agent: no change (dedup)", { alertId: input.alertId });
    return;
  }

  if (input.votedResult.confidence < config.agent.confidenceThreshold) {
    logger.info("Agent: low confidence — editing with (?) markers", {
      alertId: input.alertId,
      confidence: input.votedResult.confidence,
    });
  }

  try {
    if (input.isCaption) {
      await tgBot.api.editMessageCaption(input.chatId, input.messageId, {
        caption: newText,
        parse_mode: "HTML",
      });
    } else {
      await tgBot.api.editMessageText(input.chatId, input.messageId, newText, {
        parse_mode: "HTML",
      });
    }

    enrichment.lastEditHash = hash;
    await saveEnrichmentData(enrichment);

    // Keep session.currentText in sync for monitoring removal
    const sess = await getActiveSession();
    if (sess) {
      sess.currentText = newText;
      await setActiveSession(sess);
    }

    logger.info("Agent: enriched", {
      alertId: input.alertId,
      messageId: input.messageId,
      confidence: input.votedResult.confidence,
      sources: input.votedResult.sources_count,
      phase: input.alertType,
    });
  } catch (err) {
    const errStr = String(err);
    if (errStr.includes("message is not modified")) {
      enrichment.lastEditHash = hash;
      await saveEnrichmentData(enrichment);
    } else {
      logger.error("Agent: edit failed", {
        alertId: input.alertId,
        error: errStr,
      });
    }
  }
}
