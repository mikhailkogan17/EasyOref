import {
  config,
  getActiveSession,
  getSessionPosts,
  getSynthesizedInsights,
  getVotedInsights,
} from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import type { QaState } from "../qa-graph.js";

const OREF_HISTORY_URL =
  "https://www.oref.org.il/WarningMessages/History/AlertsHistory.json";

const BOT_HELP_TEXT: Record<string, string> = {
  ru: "Привет! Я @easyoref — ваш ИИ-помощник по ракетным обстрелам Израиля.\n\nЯ умею:\n🚨 Рассказать о текущих/последних сиренах\n🔍 Найти подробности атак (кол-во ракет, тип, перехваты)\n📰 Искать информацию в новостных каналах\n🏚 Найти ближайшее укрытие (отправьте геолокацию)\n\nПросто напишите вопрос, например:\n• «Когда была последняя сирена?»\n• «Сколько ракет запустили?»\n• «Были ли кассетные?»",
  en: 'Hi! I\'m @easyoref — your AI assistant for Israeli rocket alerts.\n\nI can:\n🚨 Tell you about current/recent sirens\n🔍 Find attack details (rocket count, type, interceptions)\n📰 Search news channels for context\n🏚 Find nearest shelters (send your location)\n\nJust ask a question, like:\n• "When was the last siren?"\n• "How many rockets were launched?"\n• "Were there cluster munitions?"',
  he: 'שלום! אני @easyoref — העוזר שלך להתרעות טילים.\n\nאני יכול:\n🚨 לעדכן על אזעקות נוכחיות/אחרונות\n🔍 למצוא פרטי תקיפות (מספר טילים, סוג, יירוטים)\n📰 לחפש מידע בערוצי חדשות\n🏚 למצוא מקלט קרוב (שלח מיקום)\n\nשאל שאלה, למשל:\n• "מתי הייתה האזעקה האחרונה?"\n• "כמה טילים שוגרו?"',
  ar: "مرحبًا! أنا @easyoref — مساعدك للتنبيهات الصاروخية.\n\nيمكنني:\n🚨 إخبارك عن الإنذارات الحالية/الأخيرة\n🔍 البحث عن تفاصيل الهجمات\n📰 البحث في القنوات الإخبارية\n🏚 إيجاد أقرب ملجأ (أرسل موقعك)",
};

const OFF_TOPIC_TEXT: Record<string, string> = {
  ru: "Привет! Я @easyoref — ИИ-помощник по ракетным обстрелам Израиля 🇮🇱\n\nЯ отвечаю только на вопросы о сиренах, ракетных атаках, перехватах и укрытиях.\n\nНапример:\n• «Когда была последняя сирена в Тель-Авиве?»\n• «Сколько ракет было?»\n• «Были ли пострадавшие?»",
  en: 'Hi! I\'m @easyoref — an AI assistant for Israeli rocket alerts 🇮🇱\n\nI only answer questions about sirens, rocket attacks, interceptions, and shelters.\n\nFor example:\n• "When was the last siren in Tel Aviv?"\n• "How many rockets were there?"\n• "Were there any casualties?"',
  he: 'שלום! אני @easyoref — עוזר בינה מלאכותית להתרעות טילים 🇮🇱\n\nאני עונה רק על שאלות לגבי אזעקות, תקיפות טילים, יירוטים ומקלטים.\n\nלמשל:\n• "מתי הייתה האזעקה האחרונה בתל אביב?"\n• "כמה טילים היו?"',
  ar: "مرحبًا! أنا @easyoref — مساعد تنبيهات صاروخية 🇮🇱\n\nأجيب فقط على أسئلة حول صفارات الإنذار والهجمات الصاروخية والاعتراضات والملاجئ.",
};

/** Fetch Oref alert history (last 24h from their public API). */
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
      .slice(0, 20)
      .map(
        (e: { alertDate?: string; title?: string; data?: string[] }) =>
          `[${e.alertDate ?? ""}] ${e.title ?? ""}: ${(e.data ?? []).join(", ")}`,
      )
      .join("\n");
  } catch (err) {
    logger.warn("contextNode: Oref history fetch failed", {
      error: String(err),
    });
    return "";
  }
}

/** Fetch current active alerts from Oref API. */
async function fetchCurrentAlerts(): Promise<string> {
  try {
    const res = await fetch(config.orefApiUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://www.oref.org.il/",
        "X-Requested-With": "XMLHttpRequest",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return "";
    const text = await res.text();
    if (!text.trim()) return "";
    const data = JSON.parse(text);
    if (!Array.isArray(data) || data.length === 0) return "";
    return data
      .map(
        (a: { alertDate?: string; title?: string; data?: string[] }) =>
          `[ACTIVE ${a.alertDate ?? ""}] ${a.title ?? ""}: ${(a.data ?? []).join(", ")}`,
      )
      .join("\n");
  } catch {
    return "";
  }
}

/** Get recent channel posts from Redis (from GramJS monitoring). */
async function getRecentChannelNews(): Promise<string> {
  try {
    const posts = await getSessionPosts();
    if (posts.length === 0) return "";

    // Sort by timestamp desc, take latest 30
    const sorted = [...posts].sort((a, b) => b.ts - a.ts).slice(0, 30);
    return sorted
      .map((p) => {
        const time = new Date(p.ts).toLocaleTimeString("he-IL", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Asia/Jerusalem",
        });
        const url = p.messageUrl ?? "";
        return `[${time}] ${p.channel}: ${p.text.slice(0, 300)}${url ? ` ${url}` : ""}`;
      })
      .join("\n\n");
  } catch (err) {
    logger.warn("contextNode: getSessionPosts failed", {
      error: String(err),
    });
    return "";
  }
}

/** Get cached enrichment insights (from the enrichment pipeline). */
async function getEnrichmentCache(): Promise<string> {
  try {
    const synthesized = await getSynthesizedInsights();
    if (synthesized.length > 0) {
      return synthesized
        .map((s) => {
          const urls = s.sourceUrls.join(", ");
          return `${s.key}: ru="${s.value.ru}" en="${s.value.en}" [sources: ${urls}]`;
        })
        .join("\n");
    }

    const voted = await getVotedInsights();
    if (voted.length > 0) {
      return voted
        .map((v) => {
          const sources = v.sources
            .map((s) => s.sourceUrl ?? s.channelId)
            .join(", ");
          return `${JSON.stringify(v.kind)} [sources: ${sources}]`;
        })
        .join("\n");
    }

    return "";
  } catch (err) {
    logger.warn("contextNode: enrichment cache read failed", {
      error: String(err),
    });
    return "";
  }
}

export async function contextNode(state: QaState): Promise<Partial<QaState>> {
  const lang = (state.language ?? "ru") as keyof typeof BOT_HELP_TEXT;

  if (state.intent === "bot_help") {
    return {
      context: BOT_HELP_TEXT[lang] ?? BOT_HELP_TEXT.ru,
      answer: BOT_HELP_TEXT[lang] ?? BOT_HELP_TEXT.ru,
    };
  }

  if (state.intent === "off_topic") {
    return {
      context: "",
      answer: OFF_TOPIC_TEXT[lang] ?? OFF_TOPIC_TEXT.ru,
    };
  }

  // Status callback: searching alerts
  if (state.statusCallback) {
    const searchMsg: Record<string, string> = {
      ru: "🔎 Проверяю оповещения...",
      en: "🔎 Checking alerts...",
      he: "🔎 בודק התרעות...",
      ar: "🔎 فحص التنبيهات...",
    };
    await state.statusCallback(searchMsg[lang] ?? searchMsg.ru);
  }

  const parts: string[] = [];

  // 1. Check active session first
  const session = await getActiveSession();
  if (session) {
    const phase = session.phase;
    const areas = session.alertAreas.join(", ");
    const time = new Date(session.latestAlertTs).toLocaleTimeString("he-IL", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jerusalem",
    });
    const sessionStart = new Date(session.sessionStartTs).toLocaleTimeString(
      "he-IL",
      { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem" },
    );
    parts.push(
      `ACTIVE SESSION:\n  Phase: ${phase}\n  Started: ${sessionStart}\n  Latest alert: ${time}\n  Areas: ${areas}`,
    );
  }

  // 2. Check enrichment cache
  const enrichCache = await getEnrichmentCache();
  if (enrichCache) {
    parts.push(
      `ENRICHMENT DATA (from monitored news channels):\n${enrichCache}`,
    );
  }

  // 3. Fetch current alerts from Oref API
  const currentAlerts = await fetchCurrentAlerts();
  if (currentAlerts) {
    parts.push(`CURRENT OREF ALERTS:\n${currentAlerts}`);
  }

  // 4. Fetch Oref history
  if (state.statusCallback) {
    const histMsg: Record<string, string> = {
      ru: "🔎 Поиск в истории оповещений...",
      en: "🔎 Searching alert history...",
      he: "🔎 חיפוש בהיסטוריית ההתרעות...",
      ar: "🔎 البحث في سجل التنبيهات...",
    };
    await state.statusCallback(histMsg[lang] ?? histMsg.ru);
  }

  const history = await fetchOrefHistory();
  if (history) parts.push(`OREF ALERT HISTORY (last 24h):\n${history}`);

  // 5. Fetch channel news from Redis
  const news = await getRecentChannelNews();
  if (news) {
    if (state.statusCallback) {
      const newsMsg: Record<string, string> = {
        ru: "🔎 Поиск по новостным каналам...",
        en: "🔎 Searching news channels...",
        he: "🔎 חיפוש בערוצי חדשות...",
        ar: "🔎 البحث في القنوات الإخبارية...",
      };
      await state.statusCallback(newsMsg[lang] ?? newsMsg.ru);
    }
    parts.push(`NEWS CHANNEL POSTS (from Telegram monitoring):\n${news}`);
  }

  if (parts.length === 0) {
    if (!session) {
      parts.push("No active alerts at the moment. No recent data available.");
    }
  }

  return { context: parts.join("\n\n---\n\n") || "No relevant context found." };
}

export { BOT_HELP_TEXT, OFF_TOPIC_TEXT };
