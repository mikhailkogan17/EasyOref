/**
 * Message text building utilities.
 *
 * buildEnrichedMessage — inserts enrichment lines into Telegram HTML text.
 * insertBeforeBlockEnd — positional insertion helper.
 * formatCitations — builds inline source links [CHANNEL]... for enrichment fields.
 */

import type {
  AlertType,
  Language,
  SynthesizedInsightType,
} from "@easyoref/shared";
import { config, getLanguagePack } from "@easyoref/shared";

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
 * @deprecated — kept for API backwards-compat; formatCitations now uses channel tags.
 */
export interface CitationMap {
  urlToIndex: Map<string, number>;
  nextIndex: number;
}

export function buildCitationMap(
  insights: SynthesizedInsightType[],
): CitationMap {
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
 * Extract channel tag from a Telegram message URL.
 *
 * - Public:  https://t.me/N12LIVE/12345  → "N12LIVE"
 * - Private: https://t.me/c/1023468930/123 → "src" (generic label for private channels)
 * - Unknown format → "src"
 */
export function channelTagFromUrl(url: string): string {
  const match = url.match(/t\.me\/([^/]+)\/(\d+)/);
  if (!match) return "src";
  const segment = match[1];
  // Private channel URLs use "c" as the first segment
  if (segment === "c") return "src";
  return segment;
}

/**
 * Format inline citations as clickable channel tag links:
 *   <a href="url">[N12LIVE]</a> <a href="url">[israel_9]</a>
 *
 * Deduplicates by URL — each unique URL appears at most once.
 * Returns empty string if no valid URLs.
 */
export function formatCitations(
  sourceUrls: string[],
  _citationMap?: CitationMap,
): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const url of sourceUrls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const tag = channelTagFromUrl(url);
    parts.push(`<a href="${url}">[${tag}]</a>`);
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
 *   eta_absolute, origin, rocket_count, is_cluster_munition,
 *   intercepted, hits, casualties
 */
export function buildEnrichedMessage(
  currentText: string,
  alertType: AlertType,
  _alertTs: number,
  insights: SynthesizedInsightType[],
): string {
  let text = currentText;

  // Strip any existing <blockquote>...</blockquote> so we rebuild cleanly
  text = text.replace(/\n?<blockquote>[\s\S]*?<\/blockquote>/g, "").trimEnd();

  const lang = config.language as Language;
  const lp = getLanguagePack(lang).labels;

  const get = (key: string) => insights.find((i) => i.key === key);

  // Collect enrichment lines
  const enrichLines: string[] = [];

  // ── ETA (not resolved) ──
  const etaInsight = get("eta_absolute");
  if (
    etaInsight?.value &&
    !isNeuroslop(etaInsight.value) &&
    alertType !== "resolved"
  ) {
    const cites = formatCitations(etaInsight.sourceUrls);
    enrichLines.push(`<b>${lp.metaArrival}:</b> ${etaInsight.value}${cites}`);
  }

  // ── Origin ──
  const originInsight = get("origin");
  if (originInsight?.value && !isNeuroslop(originInsight.value)) {
    const cites = formatCitations(originInsight.sourceUrls);
    enrichLines.push(`<b>${lp.metaOrigin}:</b> ${originInsight.value}${cites}`);
  }

  // ── Rocket count ──
  const rocketInsight = get("rocket_count");
  if (rocketInsight?.value && !isNeuroslop(rocketInsight.value)) {
    const isClusterMunition = get("is_cluster_munition")?.value
      ? lp.metaClusterMunition
      : "";
    const cites = formatCitations(rocketInsight.sourceUrls);
    enrichLines.push(
      `<b>${lp.metaRockets}:</b> ${rocketInsight.value}${isClusterMunition}${cites}`,
    );
  }

  // ── Intercepted (not early_warning) ──
  const interceptedInsight = get("intercepted");
  if (
    interceptedInsight?.value &&
    !isNeuroslop(interceptedInsight.value) &&
    alertType !== "early_warning"
  ) {
    const cites = formatCitations(interceptedInsight.sourceUrls);
    enrichLines.push(
      `<b>${lp.metaIntercepted}:</b> ${interceptedInsight.value}${cites}`,
    );
  }

  // ── Hits (not early_warning) ──
  const hitsInsight = get("hits");
  if (
    hitsInsight?.value &&
    !isNeuroslop(hitsInsight.value) &&
    alertType !== "early_warning"
  ) {
    const cites = formatCitations(hitsInsight.sourceUrls);
    enrichLines.push(`<b>${lp.metaHits}:</b> ${hitsInsight.value}${cites}`);
  }

  // ── Casualties (resolved only) ──
  const casualtiesInsight = get("casualties");
  if (
    casualtiesInsight?.value &&
    !isNeuroslop(casualtiesInsight.value) &&
    alertType === "resolved"
  ) {
    const cites = formatCitations(casualtiesInsight.sourceUrls);
    enrichLines.push(
      `<b>${lp.metaCasualties}:</b> ${casualtiesInsight.value}${cites}`,
    );
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

  return text;
}
