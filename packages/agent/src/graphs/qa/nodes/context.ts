import {
  fetchActiveAlerts,
  fetchOrefHistory,
  getActiveSession,
  getSessionPosts,
  getSynthesizedInsights,
  getVotedInsights,
} from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { QaState, QaStatusCallback } from "../qa-graph.js";

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

export async function contextNode(
  state: QaState,
  config: LangGraphRunnableConfig,
): Promise<Partial<QaState>> {
  const lang = (state.language ?? "ru") as keyof typeof BOT_HELP_TEXT;
  const statusCallback = config.configurable?.statusCallback as
    | QaStatusCallback
    | undefined;

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
  if (statusCallback) {
    const searchMsg: Record<string, string> = {
      ru: "🔎 Проверяю оповещения...",
      en: "🔎 Checking alerts...",
      he: "🔎 בודק התרעות...",
      ar: "🔎 فحص التنبيهات...",
    };
    await statusCallback(searchMsg[lang] ?? searchMsg.ru);
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

  // 3. Fetch current alerts via pikud-haoref-api
  const currentAlerts = await fetchActiveAlerts();
  if (currentAlerts.length > 0) {
    const formatted = currentAlerts
      .map(
        (a) => `[ACTIVE] ${a.instructions ?? a.type}: ${a.cities.join(", ")}`,
      )
      .join("\n");
    parts.push(`CURRENT OREF ALERTS:\n${formatted}`);
  }

  // 4. Fetch Oref history (full, no 120s filter)
  if (statusCallback) {
    const histMsg: Record<string, string> = {
      ru: "🔎 Поиск в истории оповещений...",
      en: "🔎 Searching alert history...",
      he: "🔎 חיפוש בהיסטוריית ההתרעות...",
      ar: "🔎 البحث في سجل التنبيهات...",
    };
    await statusCallback(histMsg[lang] ?? histMsg.ru);
  }

  const history = await fetchOrefHistory();
  if (history.length > 0) {
    // Group by alertDate+category to deduplicate (each alert fires for many sub-areas)
    const groups = new Map<
      string,
      { time: string; type: string; areas: string[] }
    >();
    for (const e of history) {
      const key = `${e.alertDate}|${e.category}`;
      const g = groups.get(key);
      if (g) {
        if (!g.areas.includes(e.data)) g.areas.push(e.data);
      } else {
        const time = e.alertDate.includes("T")
          ? (e.alertDate.split("T")[1]?.slice(0, 5) ?? e.alertDate)
          : e.alertDate;
        groups.set(key, { time, type: e.title, areas: [e.data] });
      }
    }
    const events = [...groups.values()];
    // Take last 80 unique events (most recent first — history already sorted desc)
    const formatted = events
      .slice(0, 80)
      .map((g) => `[${g.time}] ${g.type}: ${g.areas.join(", ")}`)
      .join("\n");
    parts.push(
      `OREF ALERT HISTORY (today, ${history.length} raw alerts, ${events.length} unique events):\n${formatted}`,
    );
  }

  // 5. Fetch channel news from Redis
  const news = await getRecentChannelNews();
  if (news) {
    if (statusCallback) {
      const newsMsg: Record<string, string> = {
        ru: "🔎 Поиск по новостным каналам...",
        en: "🔎 Searching news channels...",
        he: "🔎 חיפוש בערוצי חדשות...",
        ar: "🔎 البحث في القنوات الإخبارية...",
      };
      await statusCallback(newsMsg[lang] ?? newsMsg.ru);
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
