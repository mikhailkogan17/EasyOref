import { config, getActiveSession, getVotedInsights } from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import type { QaState } from "../../qa-graph.js";

const OREF_HISTORY_URL =
  "https://www.oref.org.il/WarningMessages/History/AlertsHistory.json";

const BOT_HELP_TEXT = {
  ru: "EasyOref — бот для оповещений о ракетных атаках в Израиле. Предоставляет аналитику и описание инцидентов в реальном времени. Для настройки используйте /start.",
  en: "EasyOref — Israeli rocket alert bot with real-time intelligence enrichment. Use /start to configure your city.",
  he: "EasyOref — בוט התרעות טילים ישראלי עם העשרת מודיעין בזמן אמת. השתמש ב-/start להגדרת העיר שלך.",
  ar: "EasyOref — بوت تنبيهات الصواريخ الإسرائيلية مع إثراء الاستخبارات في الوقت الفعلي. استخدم /start لتهيئة مدينتك.",
};

async function fetchOrefHistory(): Promise<string> {
  const url = config.orefHistoryUrl || OREF_HISTORY_URL;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://www.oref.org.il/",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return "";
    const data = await res.json();
    if (!Array.isArray(data)) return "";
    return data
      .slice(0, 10)
      .map(
        (e: { alertDate?: string; title?: string; data?: string[] }) =>
          `[${e.alertDate ?? ""}] ${e.title ?? ""}: ${(e.data ?? []).slice(0, 3).join(", ")}`,
      )
      .join("\n");
  } catch (err) {
    logger.warn("contextNode: Oref history fetch failed", {
      error: String(err),
    });
    return "";
  }
}

export async function contextNode(state: QaState): Promise<Partial<QaState>> {
  const lang = (state.language ?? "ru") as keyof typeof BOT_HELP_TEXT;

  if (state.intent === "bot_help") {
    return { context: BOT_HELP_TEXT[lang] ?? BOT_HELP_TEXT.ru };
  }

  const parts: string[] = [];

  if (state.intent === "current_alert") {
    const session = await getActiveSession();
    if (session) {
      parts.push(
        `Active alert: phase=${session.phase}, areas=${session.alertAreas.join(", ")}`,
      );
      const insights = await getVotedInsights();
      if (insights.length > 0) {
        parts.push(
          `Enrichment insights: ${insights.map((i) => JSON.stringify(i)).join("; ")}`,
        );
      }
    } else {
      parts.push("No active alert at the moment.");
    }
  }

  if (
    state.intent === "recent_history" ||
    state.intent === "general_security"
  ) {
    const history = await fetchOrefHistory();
    if (history) parts.push(`Recent alerts:\n${history}`);
    else parts.push("No recent alert history available.");
  }

  return { context: parts.join("\n\n") || "No relevant context found." };
}
