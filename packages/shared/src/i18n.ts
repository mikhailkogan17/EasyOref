/**
 * EasyOref — Internationalization (i18n)
 *
 * Supported languages: Russian (ru), English (en), Hebrew (he), Arabic (ar)
 * Default: ru (built for diaspora families)
 *
 * Message format:
 *   <b>⚠️ Title</b>
 *   Description
 *   <blockquote>
 *   <b>Key:</b> Value
 *   ...
 *   </blockquote>
 */

export type Language = "ru" | "en" | "he" | "ar";

// ── Alert metadata types ─────────────────────────────────

export type AlertKind = "early" | "siren" | "resolved";

export interface AlertLocales {
  emoji: string;
  title: string;
  description: string;
}

export interface I18nLabels {
  area: string;
  timeToImpact: string;
  earlyEta: string;
  sirenEta: string;
  monitoring: string;
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
    siren: {
      emoji: "🚨",
      title: "Цева Адом",
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
    timeToImpact: "Подлётное время",
    earlyEta: "~5–12 мин",
    sirenEta: "1.5 мин",
    monitoring:
      '<tg-emoji emoji-id="5258052328455424397">⏳</tg-emoji> Сообщение обновляется...',
  },
};

const enPack: LanguagePack = {
  alerts: {
    early: {
      emoji: "⚠️",
      title: "Early Warning",
      description: "Rocket launches detected. Stay near a protected space.",
    },
    siren: {
      emoji: "🚨",
      title: "Siren Alert",
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
    sirenEta: "1.5 min",
    monitoring:
      '<tg-emoji emoji-id="5258052328455424397">⏳</tg-emoji> Message updating...',
  },
};

const hePack: LanguagePack = {
  alerts: {
    early: {
      emoji: "⚠️",
      title: "התרעה מוקדמת",
      description: "זוהו שיגורים. הישארו בקרבת מרחב מוגן.",
    },
    siren: {
      emoji: "🚨",
      title: "צבע אדום",
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
    sirenEta: "1.5 דקות",
    monitoring:
      '<tg-emoji emoji-id="5258052328455424397">⏳</tg-emoji> ההודעה מתעדכנת...',
  },
};

const arPack: LanguagePack = {
  alerts: {
    early: {
      emoji: "⚠️",
      title: "إنذار مبكر",
      description: "تم رصد إطلاق صواريخ. ابقوا بالقرب من الملجأ.",
    },
    siren: {
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
    sirenEta: "1.5 دقيقة",
    monitoring:
      '<tg-emoji emoji-id="5258052328455424397">⏳</tg-emoji> الرسالة قيد التحديث...',
  },
};

const packs: Record<Language, LanguagePack> = {
  ru: ruPack,
  en: enPack,
  he: hePack,
  ar: arPack,
};

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
}

type LangKey = "en" | "ru" | "ar";

/** Hebrew city name → { en, ru, ar } */
const cityMap = new Map<string, Record<LangKey, string>>();
/** Hebrew zone name → { en, ru, ar } */
const zoneMap = new Map<string, Record<LangKey, string>>();
/** City ID → Hebrew name (for YAML city_ids resolution) */
const idToNameMap = new Map<number, string>();

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
