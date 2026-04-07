/**
 * EasyOref — Internationalization (i18n)
 *
 * Supported languages: Russian (ru), English (en), Hebrew (he), Arabic (ar)
 * Default: ru (built for diaspora families)
 *
 * Base message format (no blockquote):
 *   <b>⚠️ Title</b> (HH:MM)
 *   Description
 *   Район: areas
 *   ⏳ monitoring...
 *
 * Enrichment (siren/resolved): appended as <blockquote>...</blockquote>
 * Enrichment (early_warning): appended as plain text; meta reply sent separately
 */

export type Language = "ru" | "en" | "he" | "ar";

// ── Alert metadata types ─────────────────────────────────

export type AlertKind = "early" | "red_alert" | "resolved";

export interface AlertLocales {
  emoji: string;
  title: string;
  description: string;
}

export interface I18nLabels {
  area: string;
  timeToImpact: string;
  earlyEta: string;
  redAlertEta: string;
  monitoring: string;
  metaRockets: string; // label before rocket count, e.g. "Ракет"
  metaArrival: string; // label before ETA, e.g. "Прилёт"
  metaClusterMunition: string; // suffix for cluster munitions, e.g. ", кассетные"
  metaOrigin: string; // "Откуда" / "Origin" / "מקור" / "المصدر"
  metaIntercepted: string; // "Перехваты" / "Intercepted" / "יירוטים" / "اعتراضات"
  metaHits: string; // "Попадания" / "Hits" / "פגיעות" / "إصابات"
  metaCasualties: string; // "Пострадавшие" / "Casualties" / "נפגעים" / "إصابات بشرية"
  metaNoVictimsNone: string; // "нет" / "none" / "אין" / "لا"
  metaNoVictimsUnreported: string; // "не сообщается" / "not reported" / "לא דווח" / "لم يُفد"
}

export interface LanguagePack {
  alerts: Record<AlertKind, AlertLocales>;
  labels: I18nLabels;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Language Packs — structured alert metadata + labels
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const ruPack: LanguagePack = {
  alerts: {
    early: {
      emoji: "⚠️",
      title: "Раннее предупреждение",
      description: "Обнаружены запуски ракет по Израилю.",
    },
    red_alert: {
      emoji: "🚨",
      title: "Cирена",
      description: "",
    },
    resolved: {
      emoji: "😮‍💨",
      title: "Инцидент завершён",
      description: "Можно покинуть защищённое помещение.",
    },
  },
  labels: {
    area: "Район",
    timeToImpact: "Подлёт",
    earlyEta: "~5–12 мин",
    redAlertEta: "1.5 мин",
    monitoring:
      '<tg-emoji emoji-id="5258052328455424397">⏳</tg-emoji> Сообщение обновляется...',
    metaRockets: "Ракет",
    metaArrival: "Прилёт",
    metaClusterMunition: ", кассетные",
    metaOrigin: "Откуда",
    metaIntercepted: "Перехваты",
    metaHits: "Попадания",
    metaCasualties: "Пострадавшие",
    metaNoVictimsNone: "нет",
    metaNoVictimsUnreported: "не сообщается",
  },
};

const enPack: LanguagePack = {
  alerts: {
    early: {
      emoji: "⚠️",
      title: "Early Warning",
      description: "Rocket launches detected. Stay near a protected space.",
    },
    red_alert: {
      emoji: "🚨",
      title: "Red Alert",
      description: "Enter a protected space immediately.",
    },
    resolved: {
      emoji: "😮‍💨",
      title: "Incident Over",
      description: "You may leave the protected space.",
    },
  },
  labels: {
    area: "Area",
    timeToImpact: "Time to impact",
    earlyEta: "~5–12 min",
    redAlertEta: "1.5 min",
    monitoring:
      '<tg-emoji emoji-id="5258052328455424397">⏳</tg-emoji> Message updating...',
    metaRockets: "Rockets",
    metaArrival: "Arrival",
    metaClusterMunition: ", cluster",
    metaOrigin: "Origin",
    metaIntercepted: "Intercepted",
    metaHits: "Hits",
    metaCasualties: "Casualties",
    metaNoVictimsNone: "none",
    metaNoVictimsUnreported: "not reported",
  },
};

const hePack: LanguagePack = {
  alerts: {
    early: {
      emoji: "⚠️",
      title: "התרעה מוקדמת",
      description: "זוהו שיגורים. הישארו בקרבת מרחב מוגן.",
    },
    red_alert: {
      emoji: "🚨",
      title: "אזעקה",
      description: "היכנסו למרחב מוגן.",
    },
    resolved: {
      emoji: "😮‍💨",
      title: "האירוע הסתיים",
      description: "ניתן לצאת מהמרחב המוגן.",
    },
  },
  labels: {
    area: "אזור",
    timeToImpact: "זמן מעוף",
    earlyEta: "~5–12 דקות",
    redAlertEta: "1.5 דקות",
    monitoring:
      '<tg-emoji emoji-id="5258052328455424397">⏳</tg-emoji> ההודעה מתעדכנת...',
    metaRockets: "טילים",
    metaArrival: "פגיעה משוערת",
    metaClusterMunition: "מצרר",
    metaOrigin: "מקור",
    metaIntercepted: "יירוטים",
    metaHits: "פגיעות",
    metaCasualties: "נפגעים",
    metaNoVictimsNone: "אין",
    metaNoVictimsUnreported: "לא דווח",
  },
};

const arPack: LanguagePack = {
  alerts: {
    early: {
      emoji: "⚠️",
      title: "إنذار مبكر",
      description: "تم رصد إطلاق صواريخ. ابقوا بالقرب من الملجأ.",
    },
    red_alert: {
      emoji: "🚨",
      title: "صفارة إنذار",
      description: "ادخلوا إلى الملجأ فوراً.",
    },
    resolved: {
      emoji: "😮‍💨",
      title: "انتهى الحادث",
      description: "يمكنكم مغادرة الملجأ.",
    },
  },
  labels: {
    area: "المنطقة",
    timeToImpact: "وقت الوصول",
    earlyEta: "~5–12 دقيقة",
    redAlertEta: "1.5 دقيقة",
    monitoring:
      '<tg-emoji emoji-id="5258052328455424397">⏳</tg-emoji> الرسالة قيد التحديث...',
    metaRockets: "صواريخ",
    metaArrival: "الوصول المتوقع",
    metaClusterMunition: "عنقودي",
    metaOrigin: "المصدر",
    metaIntercepted: "اعتراضات",
    metaHits: "إصابات",
    metaCasualties: "إصابات بشرية",
    metaNoVictimsNone: "لا",
    metaNoVictimsUnreported: "لم يُفد",
  },
};

const packs: Record<Language, LanguagePack> = {
  ru: ruPack,
  en: enPack,
  he: hePack,
  ar: arPack,
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Bot UI Strings — localized text for interactive flows
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface BotStrings {
  // /start onboarding
  welcome: string;
  askLanguage: string;
  languageSaved: string;
  askLocation: string;
  shareLocationBtn: string;
  skipLocationBtn: string;
  registered: string; // {areas}, {lang}
  updated: string;
  areaDetected: string; // {area}
  areaNotDetected: string;
  // /settings
  settingsTitle: string;
  settingsLanguage: string;
  settingsLocation: string;
  settingsInfo: string;
  infoDisplay: string; // {chatId}, {lang}, {tier}, {areas}
  // Shelter
  shelterTitle: string;
  shelterNone: string;
  shelterFallback: string;
  // Q&A
  qaRateLimit: string;
  qaNotRegistered: string;
  qaError: string;
  // Admin
  adminUnauthorized: string;
  adminGrantUsage: string;
  adminGranted: string; // {target}
  adminRevoked: string; // {target}
  adminUserNotFound: string; // {target}
  // Common
  btnShelter: string;
  btnSettings: string;
}

const ruBot: BotStrings = {
  welcome:
    "👋 Привет! Я EasyOref — бот оповещений о ракетных атаках.\n\nВыберите язык:",
  askLanguage: "🌐 Выберите язык:",
  languageSaved: "✅ Язык сохранён.",
  askLocation:
    "📍 Отправьте вашу геолокацию, чтобы определить зону оповещений.\n\nИли нажмите «Пропустить» для зоны по умолчанию.",
  shareLocationBtn: "📍 Отправить геолокацию",
  skipLocationBtn: "⏭ Пропустить",
  registered:
    "✅ Регистрация завершена!\n\n🌐 Язык: {lang}\n📍 Зона: {areas}\n\nВы будете получать оповещения для этой зоны.",
  updated: "✅ Настройки обновлены!",
  areaDetected: "📍 Определена зона: {area}",
  areaNotDetected:
    "📍 Не удалось определить зону по геолокации. Установлена зона по умолчанию.",
  settingsTitle: "⚙️ Настройки",
  settingsLanguage: "🌐 Язык",
  settingsLocation: "📍 Зона",
  settingsInfo: "ℹ️ Мои данные",
  infoDisplay:
    "ℹ️ <b>Ваш профиль</b>\n\n🆔 Chat ID: <code>{chatId}</code>\n🌐 Язык: {lang}\n👤 Тариф: {tier}\n📍 Зоны: {areas}",
  shelterTitle: "🏚 <b>Ближайшие укрытия:</b>",
  shelterNone:
    "Укрытия поблизости не найдены.\n\nПопробуйте на сайте Пикуд ха-Ореф:\nhttps://www.oref.org.il/NAShelters/",
  shelterFallback: "https://www.oref.org.il/NAShelters/",
  qaRateLimit: "Слишком много вопросов. Подождите минуту.",
  qaNotRegistered: "Используйте /start для регистрации.",
  qaError: "Не удалось обработать вопрос. Попробуйте ещё раз.",
  adminUnauthorized: "Нет доступа.",
  adminGrantUsage:
    "Использование: /grant <chatId или @username или t.me/ссылка>",
  adminGranted: "✅ {target} повышен до Pro.",
  adminRevoked: "✅ {target} понижен до Free.",
  adminUserNotFound: "Пользователь {target} не найден.",
  btnShelter: "🏚 Укрытие",
  btnSettings: "⚙️ Настройки",
};

const enBot: BotStrings = {
  welcome: "👋 Hi! I'm EasyOref — a rocket alert bot.\n\nChoose your language:",
  askLanguage: "🌐 Choose a language:",
  languageSaved: "✅ Language saved.",
  askLocation:
    '📍 Send your location to detect your alert zone.\n\nOr tap "Skip" for the default zone.',
  shareLocationBtn: "📍 Share location",
  skipLocationBtn: "⏭ Skip",
  registered:
    "✅ Registered!\n\n🌐 Language: {lang}\n📍 Zone: {areas}\n\nYou'll receive alerts for this zone.",
  updated: "✅ Settings updated!",
  areaDetected: "📍 Detected zone: {area}",
  areaNotDetected:
    "📍 Could not detect zone from your location. Default zone set.",
  settingsTitle: "⚙️ Settings",
  settingsLanguage: "🌐 Language",
  settingsLocation: "📍 Zone",
  settingsInfo: "ℹ️ My info",
  infoDisplay:
    "ℹ️ <b>Your profile</b>\n\n🆔 Chat ID: <code>{chatId}</code>\n🌐 Language: {lang}\n👤 Tier: {tier}\n📍 Zones: {areas}",
  shelterTitle: "🏚 <b>Nearest shelters:</b>",
  shelterNone:
    "No shelters found nearby.\n\nTry the official Pikud HaOref shelter finder:\nhttps://www.oref.org.il/NAShelters/",
  shelterFallback: "https://www.oref.org.il/NAShelters/",
  qaRateLimit: "Too many questions. Please wait a minute.",
  qaNotRegistered: "Please use /start to register first.",
  qaError: "I couldn't process your question. Please try again.",
  adminUnauthorized: "Unauthorized.",
  adminGrantUsage: "Usage: /grant <chatId or @username or t.me/link>",
  adminGranted: "✅ {target} upgraded to Pro.",
  adminRevoked: "✅ {target} downgraded to Free.",
  adminUserNotFound: "User {target} not found.",
  btnShelter: "🏚 Shelter",
  btnSettings: "⚙️ Settings",
};

const heBot: BotStrings = {
  welcome: "👋 שלום! אני EasyOref — בוט התרעות טילים.\n\nבחר שפה:",
  askLanguage: "🌐 בחר שפה:",
  languageSaved: "✅ השפה נשמרה.",
  askLocation:
    '📍 שלח את המיקום שלך כדי לזהות את אזור ההתרעה.\n\nאו לחץ על "דלג" לאזור ברירת מחדל.',
  shareLocationBtn: "📍 שלח מיקום",
  skipLocationBtn: "⏭ דלג",
  registered:
    "✅ נרשמת!\n\n🌐 שפה: {lang}\n📍 אזור: {areas}\n\nתקבל התרעות לאזור זה.",
  updated: "✅ ההגדרות עודכנו!",
  areaDetected: "📍 זוהה אזור: {area}",
  areaNotDetected: "📍 לא הצלחנו לזהות אזור מהמיקום. הוגדר אזור ברירת מחדל.",
  settingsTitle: "⚙️ הגדרות",
  settingsLanguage: "🌐 שפה",
  settingsLocation: "📍 אזור",
  settingsInfo: "ℹ️ המידע שלי",
  infoDisplay:
    "ℹ️ <b>הפרופיל שלך</b>\n\n🆔 Chat ID: <code>{chatId}</code>\n🌐 שפה: {lang}\n👤 מנוי: {tier}\n📍 אזורים: {areas}",
  shelterTitle: "🏚 <b>מקלטים קרובים:</b>",
  shelterNone:
    "לא נמצאו מקלטים בסביבה.\n\nנסה באתר פיקוד העורף:\nhttps://www.oref.org.il/NAShelters/",
  shelterFallback: "https://www.oref.org.il/NAShelters/",
  qaRateLimit: "יותר מדי שאלות. אנא המתן דקה.",
  qaNotRegistered: "אנא השתמש ב-/start כדי להירשם.",
  qaError: "לא הצלחתי לעבד את השאלה. נסה שוב.",
  adminUnauthorized: "אין הרשאה.",
  adminGrantUsage: "שימוש: /grant <chatId או @username או קישור t.me>",
  adminGranted: "✅ {target} שודרג ל-Pro.",
  adminRevoked: "✅ {target} שודרג ל-Free.",
  adminUserNotFound: "משתמש {target} לא נמצא.",
  btnShelter: "🏚 מקלט",
  btnSettings: "⚙️ הגדרות",
};

const arBot: BotStrings = {
  welcome: "👋 مرحبًا! أنا EasyOref — بوت تنبيهات صواريخ.\n\nاختر لغتك:",
  askLanguage: "🌐 اختر لغة:",
  languageSaved: "✅ تم حفظ اللغة.",
  askLocation:
    '📍 أرسل موقعك لتحديد منطقة التنبيه.\n\nأو اضغط "تخطي" للمنطقة الافتراضية.',
  shareLocationBtn: "📍 مشاركة الموقع",
  skipLocationBtn: "⏭ تخطي",
  registered:
    "✅ تم التسجيل!\n\n🌐 اللغة: {lang}\n📍 المنطقة: {areas}\n\nستتلقى تنبيهات لهذه المنطقة.",
  updated: "✅ تم تحديث الإعدادات!",
  areaDetected: "📍 تم تحديد المنطقة: {area}",
  areaNotDetected: "📍 لم نتمكن من تحديد المنطقة. تم تعيين المنطقة الافتراضية.",
  settingsTitle: "⚙️ الإعدادات",
  settingsLanguage: "🌐 اللغة",
  settingsLocation: "📍 المنطقة",
  settingsInfo: "ℹ️ معلوماتي",
  infoDisplay:
    "ℹ️ <b>ملفك الشخصي</b>\n\n🆔 Chat ID: <code>{chatId}</code>\n🌐 اللغة: {lang}\n👤 الباقة: {tier}\n📍 المناطق: {areas}",
  shelterTitle: "🏚 <b>أقرب الملاجئ:</b>",
  shelterNone:
    "لم يتم العثور على ملاجئ قريبة.\n\nجرب موقع بيكود هعوريف:\nhttps://www.oref.org.il/NAShelters/",
  shelterFallback: "https://www.oref.org.il/NAShelters/",
  qaRateLimit: "أسئلة كثيرة جدًا. انتظر دقيقة.",
  qaNotRegistered: "استخدم /start للتسجيل أولاً.",
  qaError: "لم أتمكن من معالجة سؤالك. حاول مرة أخرى.",
  adminUnauthorized: "غير مصرح.",
  adminGrantUsage: "الاستخدام: /grant <chatId أو @username أو رابط t.me>",
  adminGranted: "✅ تمت ترقية {target} إلى Pro.",
  adminRevoked: "✅ تم تخفيض {target} إلى Free.",
  adminUserNotFound: "المستخدم {target} غير موجود.",
  btnShelter: "🏚 ملجأ",
  btnSettings: "⚙️ الإعدادات",
};

const botStrings: Record<Language, BotStrings> = {
  ru: ruBot,
  en: enBot,
  he: heBot,
  ar: arBot,
};

export function getBotStrings(lang: Language): BotStrings {
  return botStrings[lang] ?? botStrings.ru;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Area Name Translation — loaded from pikud-haoref-api/cities.json
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const CITIES_JSON_URL =
  "https://raw.githubusercontent.com/eladnava/pikud-haoref-api/master/cities.json";

interface CityEntry {
  id: number;
  name: string;
  name_en: string;
  name_ru: string;
  name_ar: string;
  zone: string;
  zone_en: string;
  zone_ru: string;
  zone_ar: string;
  lat: number;
  lng: number;
}

type LangKey = "en" | "ru" | "ar";

/** Hebrew city name → { en, ru, ar } */
const cityMap = new Map<string, Record<LangKey, string>>();
/** Hebrew zone name → { en, ru, ar } */
const zoneMap = new Map<string, Record<LangKey, string>>();
/** City ID → Hebrew name (for YAML city_ids resolution) */
const idToNameMap = new Map<number, string>();

// ── Polygon-based area geo-lookup ──────────────────────

const POLYGONS_JSON_URL =
  "https://raw.githubusercontent.com/eladnava/pikud-haoref-api/master/polygons.json";

/** City ID → polygon [[lat, lng], ...] */
const polygonMap = new Map<number, [number, number][]>();

/**
 * Ray-casting point-in-polygon test.
 * Returns true if (lat, lng) is inside the closed polygon.
 */
function pointInPolygon(
  lat: number,
  lng: number,
  polygon: [number, number][],
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i];
    const [yj, xj] = polygon[j];
    if (
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Find the Hebrew area name for a GPS location using Pikud HaOref polygons.
 * Returns undefined if no polygon matches (e.g. outside Israel).
 */
export function findAreaByLocation(
  lat: number,
  lng: number,
): string | undefined {
  for (const [cityId, polygon] of polygonMap) {
    if (pointInPolygon(lat, lng, polygon)) {
      return idToNameMap.get(cityId);
    }
  }
  return undefined;
}

/** Country name translation map (Source: agent extraction names) */
const COUNTRY_NAMES: Record<string, Record<Exclude<Language, "he">, string>> = {
  Iran: { ru: "Иран", en: "Iran", ar: "إيران" },
  Yemen: { ru: "Йемен", en: "Yemen", ar: "اليمن" },
  Lebanon: { ru: "Ливан", en: "Lebanon", ar: "لبنان" },
  Gaza: { ru: "Газа", en: "Gaza", ar: "غزة" },
  Iraq: { ru: "Ирак", en: "Iraq", ar: "العراق" },
  Syria: { ru: "Сирия", en: "Syria", ar: "سوريا" },
  Hezbollah: { ru: "Хезболла", en: "Hezbollah", ar: "حزب الله" },
};

/**
 * Known bad translations in upstream cities.json.
 * Applied as post-processing corrections after loading.
 * Key: Hebrew name, Value: { lang: corrected_name }
 */
const TRANSLATION_FIXES: Record<string, Partial<Record<LangKey, string>>> = {
  "תל אביב - דרום העיר ויפו": {
    ru: "Тель-Авив — Южный район и Яффо",
  },
};

/**
 * Load and cache translations from pikud-haoref-api.
 * Must be called once at startup (before first alert).
 * Falls back silently to Hebrew names on fetch failure.
 */
export async function initTranslations(): Promise<void> {
  try {
    const res = await fetch(CITIES_JSON_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: CityEntry[] = (await res.json()) as CityEntry[];

    for (const c of data) {
      if (!c.name || c.name === "בחר הכל") continue;
      cityMap.set(c.name, { en: c.name_en, ru: c.name_ru, ar: c.name_ar });
      if (c.id) idToNameMap.set(c.id, c.name);
      if (c.zone && !zoneMap.has(c.zone)) {
        zoneMap.set(c.zone, { en: c.zone_en, ru: c.zone_ru, ar: c.zone_ar });
      }
    }

    // Apply known corrections over upstream data
    for (const [heName, fixes] of Object.entries(TRANSLATION_FIXES)) {
      const existing = cityMap.get(heName);
      if (existing) {
        for (const [lang, corrected] of Object.entries(fixes)) {
          existing[lang as LangKey] = corrected!;
        }
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[i18n] Loaded ${cityMap.size} city + ${zoneMap.size} zone translations`,
    );

    // Load polygon data for GPS-based area lookup
    try {
      const polyRes = await fetch(POLYGONS_JSON_URL);
      if (!polyRes.ok) throw new Error(`HTTP ${polyRes.status}`);
      const polyData = (await polyRes.json()) as Record<
        string,
        [number, number][]
      >;
      for (const [idStr, polygon] of Object.entries(polyData)) {
        polygonMap.set(Number(idStr), polygon);
      }
      // eslint-disable-next-line no-console
      console.log(`[i18n] Loaded ${polygonMap.size} area polygons`);
    } catch (polyErr) {
      // eslint-disable-next-line no-console
      console.warn(
        "[i18n] Failed to load polygons.json — location-based area detection unavailable",
        polyErr,
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[i18n] Failed to load cities.json — area names will stay in Hebrew",
      err,
    );
  }
}

/** Translate comma-separated Hebrew area names to target language */
export function translateAreas(areas: string, lang: Language): string {
  if (lang === "he") return areas;
  const key: LangKey = lang;
  return areas
    .split(", ")
    .map((a) => {
      const city = cityMap.get(a);
      if (city?.[key]) return city[key];
      const zone = zoneMap.get(a);
      if (zone?.[key]) return zone[key];
      return a; // fallback: Hebrew as-is
    })
    .join(", ");
}

/** Translate country name from English (LLM extraction result) to target language */
export function translateCountry(name: string, lang: Language): string {
  if (lang === "he") return name; // Fallback: no Hebrew country map yet
  const entry = COUNTRY_NAMES[name];
  if (entry) return entry[lang];
  return name;
}

/**
 * Resolve numeric city IDs to Hebrew area names.
 * Call AFTER initTranslations().
 * Unknown IDs are logged as warnings and skipped.
 */
export function resolveCityIds(ids: number[]): string[] {
  const names: string[] = [];
  for (const id of ids) {
    const name = idToNameMap.get(id);
    if (name) {
      names.push(name);
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[i18n] Unknown city ID: ${id} — skipping`);
    }
  }
  return names;
}

export function getLanguagePack(lang: Language): LanguagePack {
  return packs[lang] ?? packs.ru;
}

export function isValidLanguage(s: string): s is Language {
  return s === "ru" || s === "en" || s === "he" || s === "ar";
}
