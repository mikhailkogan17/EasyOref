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
    regionRelevance: 0.9,
    sourceTrust: 0.85,
    tone: "calm" as const,
    countryOrigin: "Iran",
    rocketCount: 6,
    isClusterMunition: false,
    hitsConfirmed: undefined,
    hit_detail: undefined,
    etaRefinedMinutes: 8,
    confidence: 0.88,
    valid: true,
  },
  {
    channel: "@israelsecurity",
    messageUrl: "https://t.me/israelsecurity/5521",
    regionRelevance: 0.85,
    sourceTrust: 0.78,
    tone: "neutral" as const,
    countryOrigin: "Lebanon",
    rocketCount: 7,
    isClusterMunition: true,
    hitsConfirmed: undefined,
    hit_detail: undefined,
    etaRefinedMinutes: 9,
    confidence: 0.75,
    valid: true,
  },
  {
    channel: "@N12LIVE",
    messageUrl: "https://t.me/N12LIVE/8802",
    regionRelevance: 0.7,
    sourceTrust: 0.9,
    tone: "calm" as const,
    countryOrigin: "Iran",
    rocketCount: 5,
    isClusterMunition: undefined,
    hitsConfirmed: 2,
    hit_detail: "на открытой местности",
    etaRefinedMinutes: undefined,
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
    messageUrl: e.messageUrl ?? undefined,
  }));

  // ETA: highest-confidence source
  const withEta = indexed
    .filter((e) => e.etaRefinedMinutes !== undefined)
    .sort((a, b) => b.confidence - a.confidence);
  const bestEta = withEta[0] ?? undefined;

  // Countries: group, collect citations
  const countryMap = new Map<string, number[]>();
  for (const e of indexed) {
    if (e.countryOrigin) {
      const list = countryMap.get(e.countryOrigin) ?? [];
      list.push(e.idx);
      countryMap.set(e.countryOrigin, list);
    }
  }
  const countryOrigins =
    countryMap.size > 0
      ? Array.from(countryMap.entries()).map(([name, citations]) => ({
          name,
          citations,
        }))
      : undefined;

  // Rocket range
  const rocketSrcs = indexed.filter((e) => e.rocketCount !== undefined);
  const rocketVals = rocketSrcs.map((e) => e.rocketCount as number);
  const rocketCountMin =
    rocketVals.length > 0 ? Math.min(...rocketVals) : undefined;
  const rocketCountMax =
    rocketVals.length > 0 ? Math.max(...rocketVals) : undefined;
  const rocket_citations = rocketSrcs.map((e) => e.idx);

  // Cluster munition: majority
  const cassVals = indexed
    .filter((e) => e.isClusterMunition !== undefined)
    .map((e) => e.isClusterMunition as boolean);
  const isClusterMunition =
    cassVals.length > 0
      ? cassVals.filter(Boolean).length > cassVals.length / 2
      : undefined;

  // Hits: median
  const hitsVals = indexed
    .filter((e) => e.hitsConfirmed !== undefined)
    .map((e) => e.hitsConfirmed as number)
    .sort((a, b) => a - b);
  const hitsConfirmed =
    hitsVals.length > 0 ? hitsVals[Math.floor(hitsVals.length / 2)] : undefined;

  // Hits citations
  const hitsSrcs = indexed.filter(
    (e) => e.hitsConfirmed !== undefined && e.hitsConfirmed > 0,
  );
  const hits_citations = hitsSrcs.map((e) => e.idx);

  // Weighted confidence
  const totalWeight = indexed.reduce(
    (s, e) => s + e.sourceTrust * e.confidence,
    0,
  );

  return {
    etaRefinedMinutes: bestEta?.etaRefinedMinutes ?? undefined,
    eta_citations: bestEta ? [bestEta.idx] : [],
    countryOrigins,
    rocketCountMin,
    rocketCountMax,
    isClusterMunition,
    rocket_citations,
    hitsConfirmed,
    hits_citations,
    confidence: Math.round((totalWeight / indexed.length) * 100) / 100,
    sourcesCount: indexed.length,
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
  if (match?.index) {
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

  if (r.etaRefinedMinutes !== undefined && r.eta_citations.length > 0) {
    text = refineEtaInPlace(
      text,
      r.etaRefinedMinutes,
      alertTs,
      r.eta_citations,
    );
  }

  if (r.countryOrigins && r.countryOrigins.length > 0) {
    const parts = r.countryOrigins.map((c) => {
      const ru = COUNTRY_RU[c.name] ?? c.name;
      return `${ru}${sup(c.citations)}`;
    });
    // Leading \n creates blank line between ETA and intel block
    text = insertBeforeBlockEnd(text, `\n<b>Откуда:</b> ${parts.join(" + ")}`);
  }

  if (r.rocketCountMin !== undefined && r.rocketCountMax !== undefined) {
    const countStr =
      r.rocketCountMin === r.rocketCountMax
        ? `${r.rocketCountMin}`
        : `~${r.rocketCountMin}-${r.rocketCountMax}`;
    const clusterMunition = r.isClusterMunition ? " (кассет.)" : "";
    text = insertBeforeBlockEnd(
      text,
      `<b>Ракет:</b> ${countStr}${clusterMunition}`,
    );
  }

  if (r.hitsConfirmed !== undefined && r.hitsConfirmed > 0) {
    const hitsCite = r.hits_citations.length > 0 ? sup(r.hits_citations) : "";
    text = insertBeforeBlockEnd(
      text,
      `<b>Попадания (Дан центр):</b> ${r.hitsConfirmed}${hitsCite}`,
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
console.log(JSON.stringify(voted, undefined, 2));

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
console.log(`Sources:    ${voted.sourcesCount}`);
console.log(`Chars:      ${enriched.length} (TG caption limit: 1024)`);
