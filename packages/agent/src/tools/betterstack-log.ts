/**
 * Better Stack log query tool.
 */

import * as logger from "@easyoref/monitoring";
import { config } from "@easyoref/shared";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

export const betterstackLogTool = tool(
  async ({
    query,
    lastMinutes,
  }: {
    query: string;
    lastMinutes: number;
  }): Promise<string> => {
    const token = config.logtailToken;
    if (!token) {
      return JSON.stringify({
        error: "Better Stack token not configured",
        hint: "Set observability.betterstack_token in config.yaml",
      });
    }

    try {
      const fromDate = new Date(Date.now() - lastMinutes * 60_000).toISOString();

      const res = await fetch(
        `https://in.logtail.com/queries/logs?query=${encodeURIComponent(query)}&from=${fromDate}&to=${new Date().toISOString()}&limit=20`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(8000),
        },
      );

      if (!res.ok) {
        const status = res.status;
        if (status === 401 || status === 403) {
          return JSON.stringify({
            error: "Invalid Better Stack credentials",
            hint: "Check your observability.betterstack_token in config.yaml",
          });
        }
        return JSON.stringify({
          error: `Better Stack API returned ${status}`,
          retry: status >= 500,
        });
      }

      const json = (await res.json()) as {
        results?: Array<{ message: string; timestamp: string }>;
      };
      const logs = json.results ?? [];

      const formattedLogs = logs.map((entry) => ({
        timestamp: entry.timestamp,
        message: entry.message.slice(0, 500),
      }));

      logger.info("Tool: betterstack_log executed", {
        query,
        last_minutes: lastMinutes,
        returned: logs.length,
      });

      return JSON.stringify({
        query,
        logs: formattedLogs,
        count: logs.length,
      });
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
      "Query recent EasyOref logs from Better Stack (formerly Logtail). " +
      "Use to check: what happened in the enrichment pipeline recently, " +
      "any errors or unusual patterns. " +
      "Good for debugging: 'why did this alert enrichment fail?'",
    schema: z.object({
      query: z
        .string()
        .describe("Search query for log messages (e.g. 'error', 'alert-123')"),
      lastMinutes: z
        .number()
        .min(5)
        .max(1440)
        .default(30)
        .describe("How many minutes back to search (5-1440)"),
    }),
  },
);
