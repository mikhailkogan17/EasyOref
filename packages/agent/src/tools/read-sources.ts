/**
 * Telegram sources tool — fetch recent posts from a channel.
 */

import { fetchRecentChannelPosts } from "@easyoref/gramjs";
import * as logger from "@easyoref/monitoring";
import { config } from "@easyoref/shared";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

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
        posts: posts.map(
          (p: { text: string; ts: number; messageUrl?: string }) => ({
            text: p.text.slice(0, 800),
            ts: p.ts,
            messageUrl: p.messageUrl,
          }),
        ),
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
