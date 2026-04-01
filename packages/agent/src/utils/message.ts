/**
 * Message text building utilities.
 *
 * buildEnrichedMessage — inserts enrichment lines into Telegram HTML text.
 * stripMonitoring / appendMonitoring — monitoring-indicator helpers.
 * insertBeforeBlockEnd — positional insertion helper.
 * formatCitations — builds inline source links [1][2]... for enrichment fields.
 */

import type { AlertType, Language, SynthesizedInsightType } from "@easyoref/shared";
import { config, getLanguagePack } from "@easyoref/shared";

// ── Monitoring indicator ───────────────────────────────

export const MONITORING_RE =
  /\n?<tg-emoji emoji-id="\d+">⏳<\/tg-emoji>\s*[^\n]+$/;

export function stripMonitoring(text: string): string {
  return text.replace(MONITORING_RE, "");
}

export function appendMonitoring(text: string, label: string): string {
  return text + "\n" + label;
}

// ── Positional insertion ───────────────────────────────

/**
 * Insert a line before closing </blockquote> tag.
 * Falls back to before the "Время оповещения" line, then before last line.
 */
export function insertBeforeBlockEnd(text: string, line: string): string {
  const bqIdx = text.lastIndexOf("</blockquote>");
  if (bqIdx !== -1) {
    return text.slice(0, bqIdx) + line + "\n" + text.slice(bqIdx);
  }
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

// ── Citation formatting ────────────────────────────────

/**
 * Deduplicated citation index map across all insights.
 * Each unique sourceUrl gets a global [N] index.
 */
export interface CitationMap {
  urlToIndex: Map<string, number>;
  nextIndex: number;
}

export function buildCitationMap(insights: SynthesizedInsightType[]): CitationMap {
  const urlToIndex = new Map<string, number>();
  let nextIndex = 1;
  for (const insight of insights) {
    for (const url of insight.sourceUrls) {
      if (url && !urlToIndex.has(url)) {
        urlToIndex.set(url, nextIndex++);
      }
    }
  }
  return { urlToIndex, nextIndex };
}

/**
 * Format inline citations as HTML links: <a href="url">[1]</a> <a href="url">[2]</a>
 * Returns empty string if no valid URLs.
 */
export function formatCitations(
  sourceUrls: string[],
  citationMap: CitationMap,
): string {
  const parts: string[] = [];
  for (const url of sourceUrls) {
    const idx = citationMap.urlToIndex.get(url);
    if (idx !== undefined) {
      parts.push(`<a href="${url}">[${idx}]</a>`);
    }
  }
  return parts.length > 0 ? " " + parts.join(" ") : "";
}

// ── Neuroslop detection ────────────────────────────────

/**
 * Returns true if a synthesized value is neuroslop that should be suppressed.
 * Catches: "0", "Неизвестно", "Unknown", placeholders, empty strings.
 */
export function isNeuroslop(value: string | undefined): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  if (trimmed === "") return true;

  // Exact neuroslop values (case-insensitive)
  const NEUROSLOP_EXACT = new Set([
    "0", "?", "n/a", "none", "-",
    "неизвестно", "нет данных", "нет информации",
    "unknown", "no data", "no information",
    "לא ידוע", "אין מידע",
    "غير معروف", "لا توجد بيانات",
  ]);
  if (NEUROSLOP_EXACT.has(trimmed.toLowerCase())) return true;

  // Pattern: "Ракет: 0" or just "0 (?)" — zero rocket count
  if (/^0\s*(\(\?\))?$/.test(trimmed)) return true;

  // Pattern: angle-bracket placeholders like <Город> or <Unknown>
  if (/^<[^>]+>$/.test(trimmed)) return true;

  return false;
}

// ── Build enriched message ─────────────────────────────

/**
 * Build enriched Telegram HTML message from current text + synthesized insights.
 *
 * New format (2026-04):
 *   - early_warning: enrichment lines as plain text (no blockquote)
 *     — meta reply (sendMetaReply) handles citations separately
 *   - siren/resolved: enrichment wrapped in <blockquote>...</blockquote>
 *     appended after the base text
 *
 * Keys used from SynthesizedInsight[]:
 *   eta_absolute, origin, rocket_count, is_cassette,
 *   intercepted, hits, casualties
 */
export function buildEnrichedMessage(
  currentText: string,
  alertType: AlertType,
  _alertTs: number,
  insights: SynthesizedInsightType[],
  monitoringLabel?: string,
): string {
  let text = stripMonitoring(currentText);

  // Strip any existing <blockquote>...</blockquote> so we rebuild cleanly
  text = text.replace(/\n?<blockquote>[\s\S]*?<\/blockquote>/g, "").trimEnd();

  const lang = config.language as Language;
  const lp = getLanguagePack(lang).labels;

  const get = (key: string) => insights.find((i) => i.key === key);

  // Build global citation map for consistent numbering across all fields
  const citationMap = buildCitationMap(insights);

  // Collect enrichment lines
  const enrichLines: string[] = [];

  // ── ETA (not resolved) ──
  const etaInsight = get("eta_absolute");
  if (etaInsight?.value && !isNeuroslop(etaInsight.value) && alertType !== "resolved") {
    const cites = formatCitations(etaInsight.sourceUrls, citationMap);
    enrichLines.push(`<b>${lp.metaArrival}:</b> ${etaInsight.value}${cites}`);
  }

  // ── Origin ──
  const originInsight = get("origin");
  if (originInsight?.value && !isNeuroslop(originInsight.value)) {
    const cites = formatCitations(originInsight.sourceUrls, citationMap);
    enrichLines.push(`<b>${lp.metaOrigin}:</b> ${originInsight.value}${cites}`);
  }

  // ── Rocket count ──
  const rocketInsight = get("rocket_count");
  if (rocketInsight?.value && !isNeuroslop(rocketInsight.value)) {
    const cassette = get("is_cassette")?.value ? lp.metaCassette : "";
    const cites = formatCitations(rocketInsight.sourceUrls, citationMap);
    enrichLines.push(`<b>${lp.metaRockets}:</b> ${rocketInsight.value}${cassette}${cites}`);
  }

  // ── Intercepted (not early_warning) ──
  const interceptedInsight = get("intercepted");
  if (interceptedInsight?.value && !isNeuroslop(interceptedInsight.value) && alertType !== "early_warning") {
    const cites = formatCitations(interceptedInsight.sourceUrls, citationMap);
    enrichLines.push(`<b>${lp.metaIntercepted}:</b> ${interceptedInsight.value}${cites}`);
  }

  // ── Hits (not early_warning) ──
  const hitsInsight = get("hits");
  if (hitsInsight?.value && !isNeuroslop(hitsInsight.value) && alertType !== "early_warning") {
    const cites = formatCitations(hitsInsight.sourceUrls, citationMap);
    enrichLines.push(`<b>${lp.metaHits}:</b> ${hitsInsight.value}${cites}`);
  }

  // ── Casualties (resolved only) ──
  const casualtiesInsight = get("casualties");
  if (casualtiesInsight?.value && !isNeuroslop(casualtiesInsight.value) && alertType === "resolved") {
    const cites = formatCitations(casualtiesInsight.sourceUrls, citationMap);
    enrichLines.push(`<b>${lp.metaCasualties}:</b> ${casualtiesInsight.value}${cites}`);
  }

  // ── Append enrichment ──
  if (enrichLines.length > 0) {
    if (alertType === "early_warning") {
      // Early warning: plain text enrichment (no blockquote)
      text += "\n" + enrichLines.join("\n");
    } else {
      // Siren / resolved: wrap enrichment in blockquote
      text += "\n<blockquote>" + enrichLines.join("\n") + "</blockquote>";
    }
  }

  if (monitoringLabel && alertType !== "resolved") {
    text = appendMonitoring(text, monitoringLabel);
  }

  return text;
}
