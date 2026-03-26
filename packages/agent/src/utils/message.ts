/**
 * Message text building utilities.
 *
 * buildEnrichedMessage — inserts enrichment lines into Telegram HTML text.
 * stripMonitoring / appendMonitoring — monitoring-indicator helpers.
 * insertBeforeBlockEnd — positional insertion helper.
 */

import type { AlertType, SynthesizedInsightType } from "@easyoref/shared";

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

// ── Build enriched message ─────────────────────────────

/**
 * Build enriched Telegram HTML message from current text + synthesized insights.
 *
 * Keys used from SynthesizedInsight[]:
 *   eta_absolute, origin, rocket_count, is_cassette,
 *   intercepted, hits, casualties, earlyWarningTime
 */
export function buildEnrichedMessage(
  currentText: string,
  alertType: AlertType,
  _alertTs: number,
  insights: SynthesizedInsightType[],
  monitoringLabel?: string,
): string {
  let text = stripMonitoring(currentText);

  const get = (key: string) => insights.find((i) => i.key === key)?.value;

  // ── Refine ETA in-place ──
  const etaAbsolute = get("eta_absolute");
  if (etaAbsolute && alertType !== "resolved") {
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
        text = text.replace(pattern, etaAbsolute);
        break;
      }
    }
  }

  // ── Origin ──
  const origin = get("origin");
  if (origin) {
    text = insertBeforeBlockEnd(text, `<b>Откуда:</b> ${origin}`);
  }

  // ── Rocket count ──
  const rocketCount = get("rocket_count");
  if (rocketCount) {
    const cassette = get("is_cassette") ? ", кассетные" : "";
    text = insertBeforeBlockEnd(text, `<b>Ракет:</b> ${rocketCount}${cassette}`);
  }

  // ── Intercepted (not early_warning) ──
  const intercepted = get("intercepted");
  if (intercepted && alertType !== "early_warning") {
    text = insertBeforeBlockEnd(text, `<b>Перехваты:</b> ${intercepted}`);
  }

  // ── Hits (not early_warning) ──
  const hits = get("hits");
  if (hits && alertType !== "early_warning") {
    text = insertBeforeBlockEnd(text, `<b>Попадания:</b> ${hits}`);
  }

  // ── Casualties (resolved only) ──
  const casualties = get("casualties");
  if (casualties && alertType === "resolved") {
    text = insertBeforeBlockEnd(text, `<b>Погибшие:</b> ${casualties}`);
  }

  if (monitoringLabel && alertType !== "resolved") {
    text = appendMonitoring(text, monitoringLabel);
  }

  return text;
}
