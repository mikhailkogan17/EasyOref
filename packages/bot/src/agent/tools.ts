/**
 * LangChain tool definitions for agentic clarification.
 *
 * 4 tools the LLM can choose to call (or not):
 *
 *   1. read_telegram_sources
 *      → Fetch last 1-4 posts from a Telegram news channel via MTProto.
 *        Returns actual message texts — the LLM extracts data from them.
 *        Rate-limited: max 4 posts/call, anti-flood jitter.
 *
 *   2. alert_history
 *      → Get recent alert history from Pikud HaOref.
 *        Answers: "was there really an alert in area X recently?"
 *        More useful than active alerts (bot already has those).
 *
 *   3. resolve_area
 *      → Determine if a mentioned location is relevant to user's
 *        monitored areas. "попадание в Петах Тикве" → relevant for
 *        Герцлия? (same defense zone / Gush Dan).
 *
 *   4. betterstack_log
 *      → Query recent EasyOref logs from Better Stack.
 *        Answers: "what happened in the enrichment pipeline recently?"
 *        Uses existing Logtail token (observability.betterstack_token).
 *
 * Each tool returns a JSON string consumable by the LLM.
 * Error handling: tool failures return { error, retry } objects.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { config } from "../config.js";
import * as logger from "../logger.js";
import { fetchRecentChannelPosts } from "./gramjs-monitor.js";

// ── Area proximity data ────────────────────────────────

/**
 * Defense-zone proximity groups.
 * Cities in the same group share Iron Dome coverage, similar ETA,
 * and are typically alerted together in large barrages.
 * Source: Pikud HaOref zone mapping.
 */
const AREA_PROXIMITY_GROUPS: Record<string, string[]> = {
  "גוש דן": [
    "תל אביב",
    "רמת גן",
    "גבעתיים",
    "בני ברק",
    "חולון",
    "בת ים",
    "פתח תקווה",
    "גבעת שמואל",
    "אור יהודה",
    "יהוד",
    "קריית אונו",
  ],
  שרון: [
    "הרצליה",
    "רעננה",
    "כפר סבא",
    "הוד השרון",
    "נתניה",
    "רמת השרון",
    "כוכב יאיר",
  ],
  מרכז: [
    "ראשון לציון",
    "רחובות",
    "נס ציונה",
    "לוד",
    "רמלה",
    "מודיעין",
    "יבנה",
    "שוהם",
  ],
  ירושלים: ["ירושלים", "בית שמש", "מעלה אדומים", "מבשרת ציון"],
  חיפה: [
    "חיפה",
    "קריות",
    "קריית אתא",
    "קריית ביאליק",
    "קריית מוצקין",
    "טירת כרמל",
    "נשר",
  ],
  "דרום-מערב": ["אשקלון", "אשדוד", "גן יבנה", "קריית מלאכי"],
  "עוטף עזה": ["שדרות", "עוטף עזה", "נתיבות", "אופקים"],
  "באר שבע": ["באר שבע", "ערד", "דימונה"],
  "גליל עליון": ["קריית שמונה", "מטולה", "צפת", "ראש פינה"],
};

/**
 * Resolve whether a mentioned location is in the same defense zone
 * as any of the user's monitored areas.
 */
function resolveAreaProximity(
  mentioned: string,
  monitoredAreas: string[],
): {
  relevant: boolean;
  sameZone: string | null;
  monitoredMatch: string[];
  reasoning: string;
} {
  const mentionedLower = mentioned.trim();

  // 1. Direct match — mentioned location IS a monitored area
  for (const m of monitoredAreas) {
    if (
      m.includes(mentionedLower) ||
      mentionedLower.includes(m.split(" ")[0] ?? "")
    ) {
      return {
        relevant: true,
        sameZone: null,
        monitoredMatch: [m],
        reasoning: `"${mentioned}" directly matches monitored area "${m}"`,
      };
    }
  }

  // 2. Zone-based proximity — find which zone the mentioned area belongs to
  for (const [zone, cities] of Object.entries(AREA_PROXIMITY_GROUPS)) {
    const mentionedInZone = cities.some(
      (c) => mentionedLower.includes(c) || c.includes(mentionedLower),
    );
    if (!mentionedInZone) continue;

    // Check if any monitored area is in the same zone
    const matchedMonitored = monitoredAreas.filter((m) =>
      cities.some((c) => m.includes(c) || c.includes(m.split(" ")[0] ?? "")),
    );

    if (matchedMonitored.length > 0) {
      return {
        relevant: true,
        sameZone: zone,
        monitoredMatch: matchedMonitored,
        reasoning:
          `"${mentioned}" is in zone "${zone}" together with monitored: ` +
          matchedMonitored.join(", "),
      };
    }

    return {
      relevant: false,
      sameZone: zone,
      monitoredMatch: [],
      reasoning:
        `"${mentioned}" is in zone "${zone}" but none of user's monitored ` +
        `areas (${monitoredAreas.join(", ")}) are in that zone`,
    };
  }

  // 3. Generic region keywords
  const regionKeywords: Record<string, string[]> = {
    מרכז: ["תל אביב", "רמת גן", "פתח תקווה", "ראשון לציון", "הרצליה", "חולון"],
    צפון: ["חיפה", "קריות", "צפת", "קריית שמונה", "נצרת", "עכו", "טבריה"],
    דרום: ["באר שבע", "אשדוד", "אשקלון", "שדרות", "אילת"],
  };

  for (const [region, cities] of Object.entries(regionKeywords)) {
    if (!mentionedLower.includes(region)) continue;
    const matchedMonitored = monitoredAreas.filter((m) =>
      cities.some((c) => m.includes(c) || c.includes(m.split(" ")[0] ?? "")),
    );
    if (matchedMonitored.length > 0) {
      return {
        relevant: true,
        sameZone: region,
        monitoredMatch: matchedMonitored,
        reasoning:
          `"${mentioned}" refers to region "${region}" which includes ` +
          matchedMonitored.join(", "),
      };
    }
  }

  return {
    relevant: false,
    sameZone: null,
    monitoredMatch: [],
    reasoning:
      `"${mentioned}" could not be matched to any monitored area ` +
      `(${monitoredAreas.join(", ")})`,
  };
}

// ── Exported for testing ───────────────────────────────

export { resolveAreaProximity as _resolveAreaProximity };

// ── 1. Read Source Channels (MTProto) ──────────────────

export const readSourcesTool = tool(
  async ({
    channel,
    limit,
  }: {
    channel: string;
    limit: number;
  }): Promise<string> => {
    try {
      const safeLimit = Math.min(limit, config.agent.clarifyFetchCount);
      const posts = await fetchRecentChannelPosts(channel, safeLimit);

      if (posts.length === 0) {
        return JSON.stringify({
          channel,
          posts: [],
          note: "No recent posts found or channel not accessible",
        });
      }

      const result = {
        channel,
        posts: posts.map((p) => ({
          text: p.text.slice(0, 800),
          ts: p.ts,
          messageUrl: p.messageUrl,
        })),
        count: posts.length,
      };

      logger.info("Tool: read_telegram_sources executed", {
        channel,
        limit: safeLimit,
        returned: posts.length,
      });

      return JSON.stringify(result);
    } catch (err) {
      const errStr = String(err);
      const isRateLimit =
        errStr.includes("FLOOD") || errStr.includes("rate limit");

      logger.warn("Tool: read_telegram_sources failed", {
        channel,
        error: errStr,
      });

      return JSON.stringify({
        error: `Failed to fetch from ${channel}: ${errStr}`,
        retry: !isRateLimit,
      });
    }
  },
  {
    name: "read_telegram_sources",
    description:
      "Fetch last 1-4 posts from a Telegram news channel via MTProto. " +
      "Returns actual message texts you can extract data from. " +
      "Authoritative channels: @idf_telegram (IDF official), @N12LIVE (news), " +
      "@israelsecurity (security), @ynetalerts (Ynet). " +
      "Use when existing sources contradict each other or you need confirmation.",
    schema: z.object({
      channel: z
        .string()
        .describe("Channel username with @ prefix (e.g. @idf_telegram)"),
      limit: z
        .number()
        .min(1)
        .max(4)
        .default(3)
        .describe("Number of recent posts to fetch (1-4)"),
    }),
  },
);

// ── 2. Pikud HaOref Alert History ──────────────────────

export const alertHistoryTool = tool(
  async ({
    area,
    last_minutes,
  }: {
    area: string;
    last_minutes: number;
  }): Promise<string> => {
    try {
      const historyUrl =
        config.orefHistoryUrl ??
        "https://www.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&fromDate=" +
          formatOrefDate(new Date(Date.now() - last_minutes * 60_000)) +
          "&toDate=" +
          formatOrefDate(new Date());

      const res = await fetch(historyUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          "X-Requested-With": "XMLHttpRequest",
          Referer: "https://www.oref.org.il/",
          Accept: "application/json, text/plain, */*",
        },
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        return JSON.stringify({
          error: `Oref history API returned ${res.status}`,
          retry: true,
        });
      }

      const text = await res.text();
      if (!text.trim()) {
        return JSON.stringify({
          area,
          alerts: [],
          note: "No alert history returned for this period",
        });
      }

      const parsed: unknown = JSON.parse(text);
      const alerts = Array.isArray(parsed) ? parsed : [parsed];

      // Filter by area
      const relevant = alerts.filter((a: Record<string, unknown>) => {
        const data = (a.data as string) ?? "";
        return data.includes(area) || area.includes(data.split(" ")[0] ?? "");
      });

      const result = {
        area,
        last_minutes,
        alerts: relevant.slice(0, 20).map((a: Record<string, unknown>) => ({
          date: a.alertDate ?? a.date,
          title: a.title,
          data: a.data,
          category: a.category_desc ?? a.category,
        })),
        total_in_period: alerts.length,
        relevant_count: relevant.length,
        queried_at: new Date().toISOString(),
      };

      logger.info("Tool: alert_history executed", {
        area,
        last_minutes,
        total: alerts.length,
        relevant: relevant.length,
      });

      return JSON.stringify(result);
    } catch (err) {
      logger.warn("Tool: alert_history failed", { error: String(err) });
      return JSON.stringify({
        error: `Oref history API call failed: ${String(err)}`,
        retry: true,
      });
    }
  },
  {
    name: "alert_history",
    description:
      "Get recent alert history from Pikud HaOref (Israel Home Front Command). " +
      "Answers: 'was there really an alert in area X in the last N minutes?' " +
      "More useful than active alerts (the bot already has the current alert). " +
      "Use to verify channel claims about attacks in specific areas.",
    schema: z.object({
      area: z
        .string()
        .describe("Hebrew area name to search for in history (e.g. תל אביב)"),
      last_minutes: z
        .number()
        .min(5)
        .max(120)
        .default(30)
        .describe("How many minutes of history to search (5-120)"),
    }),
  },
);

// ── 3. Resolve Area Relevance ──────────────────────────

export const resolveAreaTool = tool(
  async ({ location }: { location: string }): Promise<string> => {
    const monitoredAreas = config.areas;

    if (monitoredAreas.length === 0) {
      return JSON.stringify({
        error: "No monitored areas configured",
        hint: "User has not set up city monitoring",
      });
    }

    const result = resolveAreaProximity(location, monitoredAreas);

    logger.info("Tool: resolve_area executed", {
      location,
      relevant: result.relevant,
      zone: result.sameZone,
    });

    return JSON.stringify({
      location,
      monitored_areas: monitoredAreas,
      ...result,
    });
  },
  {
    name: "resolve_area",
    description:
      "Determine if a location mentioned in news is relevant to the user's " +
      "monitored areas. Uses defense-zone proximity: cities in the same Iron Dome " +
      "coverage zone are considered relevant. " +
      'Example: "попадание в Петах Тикве" → relevant for Herzliya user ' +
      "(both in Gush Dan / Sharon zone). " +
      'Use when a news post mentions a city or region like "center" and you need ' +
      "to determine if it affects the user.",
    schema: z.object({
      location: z
        .string()
        .describe(
          "City or region name in Hebrew as mentioned in news (e.g. פתח תקווה, מרכז)",
        ),
    }),
  },
);

// ── Helper ─────────────────────────────────────────────

/** Format date as DD.MM.YYYY for Oref history API */
function formatOrefDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

export { formatOrefDate as _formatOrefDate };

// ── 4. Better Stack Log Query ──────────────────────────

export const betterstackLogTool = tool(
  async ({
    query,
    last_minutes,
  }: {
    query: string;
    last_minutes: number;
  }): Promise<string> => {
    const token = config.logtailToken;
    if (!token) {
      return JSON.stringify({
        error: "Better Stack token not configured",
        hint: "Set observability.betterstack_token in config.yaml or LOGTAIL_TOKEN env",
      });
    }

    try {
      const now = new Date();
      const from = new Date(now.getTime() - last_minutes * 60_000);

      const params = new URLSearchParams({
        query,
        batch: "20",
        from: from.toISOString(),
        to: now.toISOString(),
        order: "newest_first",
      });

      const res = await fetch(
        `https://logs.betterstack.com/api/v1/query?${params}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(8000),
        },
      );

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return JSON.stringify({
          error: `Better Stack API returned ${res.status}`,
          body: body.slice(0, 200),
          retry: res.status >= 500,
        });
      }

      const json = (await res.json()) as { data?: unknown[] };
      const events = Array.isArray(json.data) ? json.data : [];

      const result = {
        query,
        last_minutes,
        events: events.slice(0, 20).map((e) => {
          const ev = e as Record<string, unknown>;
          return {
            dt: ev.dt ?? ev.timestamp,
            message: ev.message ?? ev.msg,
            level: ev.level ?? ev.severity,
            context: ev.context ?? ev.metadata,
          };
        }),
        total: events.length,
        queried_at: now.toISOString(),
      };

      logger.info("Tool: betterstack_log executed", {
        query,
        last_minutes,
        total: events.length,
      });

      return JSON.stringify(result);
    } catch (err) {
      logger.warn("Tool: betterstack_log failed", { error: String(err) });
      return JSON.stringify({
        error: `Better Stack query failed: ${String(err)}`,
        retry: true,
      });
    }
  },
  {
    name: "betterstack_log",
    description:
      "Query recent EasyOref logs from Better Stack (Logtail). " +
      "Search for log entries matching a text query within a time window. " +
      "Use when you need to understand what the enrichment pipeline did recently — " +
      "e.g. which alerts were processed, what extractions were made, or why " +
      "confidence was low. Returns up to 20 most recent matching log entries.",
    schema: z.object({
      query: z
        .string()
        .describe(
          "Text to search for in logs (e.g. 'alert_history', 'Clarify', 'enrichment')",
        ),
      last_minutes: z
        .number()
        .min(1)
        .max(60)
        .default(15)
        .describe("How many minutes of logs to search (1-60)"),
    }),
  },
);

// ── Exported tool array ────────────────────────────────

export const clarifyTools = [
  readSourcesTool,
  alertHistoryTool,
  resolveAreaTool,
  betterstackLogTool,
];
