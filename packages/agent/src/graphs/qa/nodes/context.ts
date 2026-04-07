import type { TzevaAdomWave } from "@easyoref/shared";
import {
  config as appConfig,
  fetchActiveAlerts,
  fetchTzevaAdomHistory,
  getActiveSession,
  getSessionPosts,
  getSynthesizedInsights,
  getVotedInsights,
  resolveCityIds,
  toIsraelTime,
  translateAreas,
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

/** Format TzevaAdom waves for the LLM context — translate cities, format timestamps. */
function formatWavesForLLM(
  waves: TzevaAdomWave[],
  userCities: Set<string>,
): string {
  const lines: string[] = [];
  for (const wave of waves) {
    // Check if ANY alert in this wave touches user's cities
    const userAlerts = wave.alerts.filter((a) =>
      a.cities.some((c) => userCities.has(c)),
    );
    const otherAlerts = wave.alerts.filter(
      (a) => !a.cities.some((c) => userCities.has(c)),
    );

    const waveTime = toIsraelTime(wave.alerts[0]!.time * 1000);
    const threatType =
      wave.alerts[0]!.threat === 5 ? "hostile aircraft" : "rocket/missile";

    if (userAlerts.length > 0) {
      // This wave hit user's area
      const allTimes = userAlerts.map((a) => toIsraelTime(a.time * 1000));
      const uniqueTimes = [...new Set(allTimes)];
      const allCities = userAlerts.flatMap((a) =>
        a.cities.map((c) => translateAreas(c, "en")),
      );
      const uniqueCities = [...new Set(allCities)];
      lines.push(
        `🚨 ATTACK #${wave.id} at ${uniqueTimes.join(", ")} — YOUR AREA — ${threatType}`,
      );
      lines.push(`   Cities: ${uniqueCities.join(", ")}`);
      if (otherAlerts.length > 0) {
        const otherCount = otherAlerts.reduce(
          (sum, a) => sum + a.cities.length,
          0,
        );
        lines.push(`   Also hit ${otherCount} other cities in this wave`);
      }
    } else {
      // Wave didn't hit user's area — summarize briefly
      const totalCities = wave.alerts.reduce(
        (sum, a) => sum + a.cities.length,
        0,
      );
      // Pick a few representative cities
      const someCities = wave.alerts
        .slice(0, 2)
        .flatMap((a) =>
          a.cities.slice(0, 3).map((c) => translateAreas(c, "en")),
        );
      lines.push(
        `   Attack #${wave.id} at ${waveTime} — ${threatType} — ${totalCities} cities (${someCities.join(", ")}...)`,
      );
    }
  }
  return lines.join("\n");
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
      ru: "🔎 Проверяю текущие оповещения...",
      en: "🔎 Checking alerts...",
      he: "🔎 בודק התרעות...",
      ar: "🔎 فحص التنبيهات...",
    };
    await statusCallback(searchMsg[lang] ?? searchMsg.ru);
  }

  const parts: string[] = [];
  let historyError = false;

  // User's configured cities (Hebrew)
  const userCityNames = resolveCityIds(appConfig.cityIds);
  const userCitySet = new Set(userCityNames);

  // 1. Check active session
  const session = await getActiveSession();
  if (session) {
    const phase = session.phase;
    const areas = session.alertAreas.join(", ");
    const time = toIsraelTime(session.latestAlertTs);
    const sessionStart = toIsraelTime(session.sessionStartTs);
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
        (a) =>
          `[ACTIVE NOW] ${a.instructions ?? a.type}: ${a.cities.map((c) => translateAreas(c, "en")).join(", ")}`,
      )
      .join("\n");
    parts.push(`CURRENT ACTIVE ALERTS:\n${formatted}`);
  }

  // 4. Fetch TzevaAdom history (reliable API)
  if (statusCallback) {
    const histMsg: Record<string, string> = {
      ru: "🔎 Загружаю историю атак...",
      en: "🔎 Loading attack history...",
      he: "🔎 טוען היסטוריית תקיפות...",
      ar: "🔎 تحميل سجل الهجمات...",
    };
    await statusCallback(histMsg[lang] ?? histMsg.ru);
  }

  let waves: TzevaAdomWave[] = [];
  try {
    waves = await fetchTzevaAdomHistory();
  } catch (err) {
    logger.error("contextNode: fetchTzevaAdomHistory failed", {
      error: String(err),
    });
    historyError = true;
  }

  if (waves.length > 0) {
    const formatted = formatWavesForLLM(waves, userCitySet);
    const userWaves = waves.filter((w) =>
      w.alerts.some((a) => a.cities.some((c) => userCitySet.has(c))),
    );
    parts.push(
      `ATTACK HISTORY (last 24h, ${waves.length} attack waves total, ${userWaves.length} hit your area):\n${formatted}`,
    );
  } else if (!historyError) {
    parts.push("ATTACK HISTORY: No attacks recorded in the last 24 hours.");
  }

  if (historyError) {
    parts.push(
      "⚠️ ATTACK HISTORY UNAVAILABLE: Could not load attack history. Tell the user the history service is temporarily unavailable.",
    );
  }

  // 5. Pre-fetch channel news from Redis (for answer node's search tool)
  let posts: unknown[] = [];
  try {
    const rawPosts = await getSessionPosts();
    posts = rawPosts;
  } catch (err) {
    logger.warn("contextNode: getSessionPosts failed", { error: String(err) });
  }

  if (parts.length === 0) {
    parts.push("No active alerts and no recent attack data available.");
  }

  return {
    context: parts.join("\n\n---\n\n"),
    posts,
  };
}

export { BOT_HELP_TEXT, OFF_TOPIC_TEXT };
