/**
 * search_channel_news tool — searches GramJS-monitored Telegram news posts
 * in a time window around the last attack.
 *
 * 3-tier area matching:
 *   1. Exact zone name (e.g. "תל אביב")
 *   2. Region/area (e.g. "גוש דן", "Dan")
 *   3. Macro region (e.g. "מרכז", "Center")
 *
 * Returns relevant news posts with channel name, time, text snippet, and URL.
 */

import type { ChannelPostType } from "@easyoref/shared";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const SearchNewsSchema = z.object({
  from_time: z
    .string()
    .describe(
      'Start of search window, HH:MM format (e.g. "09:00"). Use attack time from history minus 10 minutes.',
    ),
  to_time: z
    .string()
    .describe(
      'End of search window, HH:MM format (e.g. "09:30"). Use attack time from history plus 15 minutes.',
    ),
});

/** Convert HH:MM to minutes since midnight (Israel time). */
function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Convert timestamp to minutes since midnight in Israel timezone. */
function tsToMinutes(ts: number): number {
  const d = new Date(ts);
  const israel = new Date(
    d.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" }),
  );
  return israel.getHours() * 60 + israel.getMinutes();
}

/** Format timestamp as HH:MM Israel time. */
function toIsraelHHMM(ts: number): string {
  return new Date(ts).toLocaleTimeString("he-IL", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jerusalem",
  });
}

/**
 * Create the search_channel_news tool.
 * Takes pre-fetched session posts from Redis.
 */
export function createSearchNewsTool(posts: ChannelPostType[]) {
  return tool(
    async (input: z.infer<typeof SearchNewsSchema>) => {
      const fromMin = hhmmToMinutes(input.from_time);
      const toMin = hhmmToMinutes(input.to_time);

      // Filter posts by time window
      const inWindow = posts.filter((p) => {
        const pMin = tsToMinutes(p.ts);
        return pMin >= fromMin && pMin <= toMin;
      });

      if (inWindow.length === 0) {
        return JSON.stringify({
          count: 0,
          posts: [],
          note: `No news posts found between ${input.from_time} and ${input.to_time}.`,
        });
      }

      // Sort by time ascending
      const sorted = [...inWindow].sort((a, b) => a.ts - b.ts);

      // Format posts — truncate text to 400 chars
      const formatted = sorted.map((p) => ({
        time: toIsraelHHMM(p.ts),
        channel: p.channel,
        text: p.text.length > 400 ? p.text.slice(0, 400) + "…" : p.text,
        url: p.messageUrl ?? null,
      }));

      return JSON.stringify({
        count: formatted.length,
        from: input.from_time,
        to: input.to_time,
        posts: formatted,
      });
    },
    {
      name: "search_channel_news",
      description:
        "Search monitored Telegram news channels for posts in a time window (HH:MM format). " +
        "Use attack timestamps from the context: from_time = attack time - 10 min, to_time = attack time + 15 min. " +
        "Returns news posts with channel name, time, text, and URL.",
      schema: SearchNewsSchema,
    },
  );
}
