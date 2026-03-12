/**
 * Dry-run: test vote + buildEnrichedMessage without Redis / Telegram / LLM.
 *
 * Usage:
 *   npx tsx packages/bot/src/agent/dry-run.ts
 *
 * Prints the enriched message HTML to stdout.
 * Strip HTML tags to preview plain text:
 *   npx tsx packages/bot/src/agent/dry-run.ts | sed 's/<[^>]*>//g'
 */

// ── Mock base message (as formatMessage() would produce) ──────────────────────

const BASE_MESSAGE = [
  "<b>🚀 Ракетная атака</b>",
  "Ожидаются прилёты. Пройдите в укрытие.",
  "",
  "<b>Район:</b> Тель-Авив — Яффо",
  "<b>Подлётное время:</b> ~5–12 мин",
  "<b>Время оповещения:</b> 03:47",
].join("\n");

// ── Mock validated extractions (normally come from LLM) ───────────────────────

const NOW = Date.now();
const ALERT_TS = NOW - 90_000; // alert was 90s ago

const MOCK_EXTRACTIONS = [
  {
    channel: "@newsflashhhj",
    messageUrl: "https://t.me/newsflashhhj/12340",
    region_relevance: 0.9,
    source_trust: 0.85,
    tone: "calm" as const,
    country_origin: "Iran",
    rocket_count: 6,
    is_cassette: false,
    hits_confirmed: null,
    eta_refined_minutes: 8,
    confidence: 0.88,
    valid: true,
  },
  {
    channel: "@israelsecurity",
    messageUrl: "https://t.me/israelsecurity/5521",
    region_relevance: 0.85,
    source_trust: 0.78,
    tone: "neutral" as const,
    country_origin: "Lebanon",
    rocket_count: 7,
    is_cassette: true,
    hits_confirmed: null,
    eta_refined_minutes: 9,
    confidence: 0.75,
    valid: true,
  },
  {
    channel: "@N12LIVE",
    messageUrl: "https://t.me/N12LIVE/8802",
    region_relevance: 0.7,
    source_trust: 0.9,
    tone: "calm" as const,
    country_origin: "Iran",
    rocket_count: 5,
    is_cassette: null,
    hits_confirmed: 2,
    eta_refined_minutes: null,
    confidence: 0.82,
    valid: true,
  },
];

// ── Inline copy of vote() + buildEnrichedMessage() ────────────────────────────
// (avoids importing config / redis which require a real config.yaml)

const SUPERSCRIPTS = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"];
function sup(indices: number[]): string {
  return indices
    .map((n) =>
      String(n)
        .split("")
        .map((d) => SUPERSCRIPTS[Number(d)])
        .join(""),
    )
    .join("");
}

const COUNTRY_RU: Record<string, string> = {
  Iran: "Иран",
  Yemen: "Йемен",
  Lebanon: "Ливан",
  Gaza: "Газа",
  Iraq: "Ирак",
  Syria: "Сирия",
  Hezbollah: "Хезболла",
};

function vote(extractions: typeof MOCK_EXTRACTIONS) {
  const indexed = extractions.map((e, i) => ({ ...e, idx: i + 1 }));

  const citedSources = indexed.map((e) => ({
    index: e.idx,
    channel: e.channel,
    messageUrl: e.messageUrl ?? null,
  }));

  // ETA: highest-confidence source
  const withEta = indexed
    .filter((e) => e.eta_refined_minutes !== null)
    .sort((a, b) => b.confidence - a.confidence);
  const bestEta = withEta[0] ?? null;

  // Countries: group, collect citations
  const countryMap = new Map<string, number[]>();
  for (const e of indexed) {
    if (e.country_origin) {
      const list = countryMap.get(e.country_origin) ?? [];
      list.push(e.idx);
      countryMap.set(e.country_origin, list);
    }
  }
  const country_origins =
    countryMap.size > 0
      ? Array.from(countryMap.entries()).map(([name, citations]) => ({
          name,
          citations,
        }))
      : null;

  // Rocket range
  const rocketSrcs = indexed.filter((e) => e.rocket_count !== null);
  const rocketVals = rocketSrcs.map((e) => e.rocket_count as number);
  const rocket_count_min =
    rocketVals.length > 0 ? Math.min(...rocketVals) : null;
  const rocket_count_max =
    rocketVals.length > 0 ? Math.max(...rocketVals) : null;
  const rocket_citations = rocketSrcs.map((e) => e.idx);

  // Cassette: majority
  const cassVals = indexed
    .filter((e) => e.is_cassette !== null)
    .map((e) => e.is_cassette as boolean);
  const is_cassette =
    cassVals.length > 0
      ? cassVals.filter(Boolean).length > cassVals.length / 2
      : null;

  // Hits: median
  const hitsVals = indexed
    .filter((e) => e.hits_confirmed !== null)
    .map((e) => e.hits_confirmed as number)
    .sort((a, b) => a - b);
  const hits_confirmed =
    hitsVals.length > 0 ? hitsVals[Math.floor(hitsVals.length / 2)] : null;

  // Hits citations
  const hitsSrcs = indexed.filter(
    (e) => e.hits_confirmed !== null && e.hits_confirmed > 0,
  );
  const hits_citations = hitsSrcs.map((e) => e.idx);

  // Weighted confidence
  const totalWeight = indexed.reduce(
    (s, e) => s + e.source_trust * e.confidence,
    0,
  );

  return {
    eta_refined_minutes: bestEta?.eta_refined_minutes ?? null,
    eta_citations: bestEta ? [bestEta.idx] : [],
    country_origins,
    rocket_count_min,
    rocket_count_max,
    is_cassette,
    rocket_citations,
    hits_confirmed,
    hits_citations,
    confidence: Math.round((totalWeight / indexed.length) * 100) / 100,
    sources_count: indexed.length,
    citedSources,
  };
}

function insertBeforeBlockEnd(text: string, line: string): string {
  const bqIdx = text.lastIndexOf("</blockquote>");
  if (bqIdx !== -1) {
    return text.slice(0, bqIdx) + line + "\n" + text.slice(bqIdx);
  }
  const timeLinePattern = /(<b>Время оповещения:<\/b>)/;
  const match = text.match(timeLinePattern);
  if (match?.index !== undefined) {
    return text.slice(0, match.index) + line + "\n" + text.slice(match.index);
  }
  const lines = text.split("\n");
  lines.splice(Math.max(lines.length - 1, 0), 0, line);
  return lines.join("\n");
}

function refineEtaInPlace(
  text: string,
  minutes: number,
  alertTs: number,
  citations: number[],
): string {
  const absTime = new Date(alertTs + minutes * 60_000).toLocaleTimeString(
    "he-IL",
    { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jerusalem" },
  );
  const refined = `~${absTime}${sup(citations)}`;

  const etaPatterns = [
    /~\d+[–-]\d+\s*мин/,
    /~\d+[–-]\d+\s*min/,
    /~\d+[–-]\d+\s*דקות/,
    /1\.5\s*мин/,
    /1\.5\s*min/,
  ];
  for (const pattern of etaPatterns) {
    if (pattern.test(text)) return text.replace(pattern, refined);
  }
  return text;
}

function buildEnrichedMessage(
  currentText: string,
  alertTs: number,
  r: ReturnType<typeof vote>,
): string {
  let text = currentText;

  if (r.eta_refined_minutes !== null && r.eta_citations.length > 0) {
    text = refineEtaInPlace(
      text,
      r.eta_refined_minutes,
      alertTs,
      r.eta_citations,
    );
  }

  if (r.country_origins && r.country_origins.length > 0) {
    const parts = r.country_origins.map((c) => {
      const ru = COUNTRY_RU[c.name] ?? c.name;
      return `${ru}${sup(c.citations)}`;
    });
    // Leading \n creates blank line between ETA and intel block
    text = insertBeforeBlockEnd(text, `\n<b>Откуда:</b> ${parts.join(" + ")}`);
  }

  if (r.rocket_count_min !== null && r.rocket_count_max !== null) {
    const countStr =
      r.rocket_count_min === r.rocket_count_max
        ? `${r.rocket_count_min}`
        : `~${r.rocket_count_min}-${r.rocket_count_max}`;
    const cassette = r.is_cassette ? " (кассет.)" : "";
    text = insertBeforeBlockEnd(text, `<b>Ракет:</b> ${countStr}${cassette}`);
  }

  if (r.hits_confirmed !== null && r.hits_confirmed > 0) {
    const hitsCite = r.hits_citations.length > 0 ? sup(r.hits_citations) : "";
    text = insertBeforeBlockEnd(
      text,
      `<b>Попадания (Дан центр):</b> ${r.hits_confirmed}${hitsCite}`,
    );
  }

  const sourcesWithUrl = r.citedSources.filter((s) => s.messageUrl);
  if (sourcesWithUrl.length > 0) {
    const links = sourcesWithUrl
      .map((s) => `<a href="${s.messageUrl}">[${s.index}]</a>`)
      .join("  ");
    text += `\n—\n<i>Источники: ${links}</i>`;
  }

  return text;
}

// ── Run ───────────────────────────────────────────────────────────────────────

const voted = vote(MOCK_EXTRACTIONS);

console.log("\n=== VOTE RESULT ===");
console.log(JSON.stringify(voted, null, 2));

const enriched = buildEnrichedMessage(BASE_MESSAGE, ALERT_TS, voted);

console.log("\n=== ENRICHED MESSAGE (HTML) ===");
console.log(enriched);

console.log("\n=== PLAIN TEXT PREVIEW ===");
console.log(
  enriched
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">"),
);

console.log(`\n=== STATS ===`);
console.log(`Confidence: ${voted.confidence}`);
console.log(`Sources:    ${voted.sources_count}`);
console.log(`Chars:      ${enriched.length} (TG caption limit: 1024)`);
