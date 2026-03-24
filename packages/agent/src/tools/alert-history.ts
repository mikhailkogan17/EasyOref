/**
 * Alert history tool — query Pikud HaOref history.
 */

/** Format date as DD.MM.YYYY for Oref history API */
function formatOrefDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

export { formatOrefDate };

import * as logger from "@easyoref/monitoring";
import { config } from "@easyoref/shared";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const alertHistoryTool = tool(
  async ({
    area,
    lastMinutes,
  }: {
    area: string;
    lastMinutes: number;
  }): Promise<string> => {
    try {
      const historyUrl =
        config.orefHistoryUrl ??
        "https://www.oref.org.il/Shared/Ajax/GetAlarmsHistory.aspx?lang=he&fromDate=" +
          formatOrefDate(new Date(Date.now() - lastMinutes * 60_000)) +
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

      const relevant = alerts.filter((a: Record<string, unknown>) => {
        const data = (a.data as string) ?? "";
        return data.includes(area) || area.includes(data.split(" ")[0] ?? "");
      });

      const result = {
        area,
        last_minutes: lastMinutes,
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
        last_minutes: lastMinutes,
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
      lastMinutes: z
        .number()
        .min(5)
        .max(120)
        .default(30)
        .describe("How many minutes of history to search (5-120)"),
    }),
  },
);
