/**
 * Clarify Node — optional ReAct tool calling for low-confidence enrichment.
 */

import * as logger from "@easyoref/monitoring";
import {
  ClarifyOutputSchema,
  config,
  pushSessionPost,
  type ChannelPost,
  type ValidatedExtraction,
} from "@easyoref/shared";
import { ChatOpenRouter } from "@langchain/openrouter";
import { createAgent, toolStrategy } from "langchain";
import type { AgentStateType } from "../graph.js";
import { clarifyTools } from "../tools.js";

const clarifyModel = new ChatOpenRouter({
  apiKey: config.agent.apiKey,
  model: config.agent.filterModel,
  temperature: 0,
  maxTokens: 600,
});

const clarifyAgent = createAgent({
  model: clarifyModel,
  tools: clarifyTools,
  responseFormat: toolStrategy(ClarifyOutputSchema),
  systemPrompt: `
  You are the clarification agent for EasyOref — an Israeli missile alert enrichment system.

  The voting pipeline analyzed Telegram channel posts and produced a result with
  low confidence or contradictions. You have access to 4 tools:

    1. read_telegram_sources — fetch last N posts from a Telegram news channel
    2. alert_history — get recent alert history from Pikud HaOref.
    3. resolve_area — check if a location mentioned in news is relevant to user's areas.
    4. betterstack_log — query recent EasyOref logs from Better Stack.

  CRITICAL — TIME VALIDATION:
  You receive the alert time (Israel timezone). Channel posts may be about PREVIOUS
  attacks or ongoing military operations (not THIS specific alert). When in doubt:
  - Use alert_history to verify if an alert really occurred at the claimed time/area.
  - If a post discusses events from hours ago, it is STALE — ignore it.

  You decide whether tools would help:
  - If contradictions can be resolved with existing data → respond immediately, no tools.
  - If an authoritative source (IDF, N12) could settle a disagreement → fetch 1-4 posts.
  - If you need to verify whether an alert occurred → check alert_history.

  Always respect an output format.
  `,
});

const describeContradictions = (
  extractions: ValidatedExtraction[],
  voted: {
    country_origins?: { name: string }[];
    rocket_count_min?: number;
    rocket_count_max?: number;
    intercepted_confidence?: number;
    intercepted?: number;
    hits_confidence?: number;
    hits_confirmed?: number;
    confidence: number;
    sources_count: number;
  },
): string => {
  const issues: string[] = [];

  if (voted.country_origins && voted.country_origins.length > 1) {
    const names = voted.country_origins.map((c) => c.name).join(", ");
    issues.push(`Multiple origin countries reported: ${names}`);
  }

  if (
    voted.rocket_count_min &&
    voted.rocket_count_max &&
    voted.rocket_count_max - voted.rocket_count_min > 3
  ) {
    issues.push(
      `Wide rocket count range: ${voted.rocket_count_min}–${voted.rocket_count_max}`,
    );
  }

  if (
    (voted.intercepted_confidence ?? 0) < 0.5 &&
    voted.intercepted !== undefined
  ) {
    issues.push(
      `Intercepted count (${voted.intercepted}) has low confidence: ${(
        voted.intercepted_confidence ?? 0
      ).toFixed(2)}`,
    );
  }

  issues.push(`Overall confidence: ${voted.confidence}`);
  issues.push(`Sources count: ${voted.sources_count}`);

  return issues.join("\n");
};

export const clarifyNode = async (
  state: AgentStateType,
): Promise<Partial<AgentStateType>> => {
  if (!state.votedResult) {
    logger.info("Agent: clarify skipped — no voted result", {
      alertId: state.alertId,
    });
    return { clarifyAttempted: true };
  }

  logger.info("Agent: clarify triggered", {
    alertId: state.alertId,
    confidence: state.votedResult.confidence,
  });

  try {
    const contradictions = describeContradictions(
      state.extractions,
      state.votedResult,
    );

    const alertTimeIL = new Date(state.alertTs).toLocaleTimeString("he-IL", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jerusalem",
    });

    const userPrompt =
      `Alert region: ${state.alertAreas.join(", ")}\n` +
      `Alert type: ${state.alertType}\n` +
      `Alert time: ${alertTimeIL} (Israel)\n` +
      `Message ID: ${state.messageId}\n\n` +
      `Current voted result:\n` +
      JSON.stringify(state.votedResult, undefined, 2) +
      `\n\nContradictions & issues:\n${contradictions}\n\n` +
      `Existing extractions (${
        state.extractions.filter((e) => e.valid).length
      } valid):\n` +
      state.extractions
        .filter((e) => e.valid)
        .map(
          (e) =>
            `  [${e.channel}] country=${e.country_origin}, rockets=${e.rocket_count}, ` +
            `intercepted=${e.intercepted}, hits=${e.hits_confirmed}, conf=${e.confidence}`,
        )
        .join("\n") +
      `\n\nDecide: would fetching more data from authoritative channels resolve these issues?`;

    const result = await clarifyAgent.invoke({ messages: [userPrompt] });
    const output = result.structuredResponse;

    const newPosts: ChannelPost[] = [];
    if (output?.newPosts) {
      for (const p of output.newPosts) {
        const post: ChannelPost = {
          channel: p.channel,
          text: p.text,
          ts: p.ts,
          messageUrl: p.messageUrl,
        };
        newPosts.push(post);
        await pushSessionPost(post);
      }
    }

    return {
      extractions: [...state.extractions, ...(output?.newExtractions ?? [])],
      votedResult: undefined,
      clarifyAttempted: true,
    };
  } catch (err) {
    logger.error("Agent: clarify failed", {
      alertId: state.alertId,
      error: String(err),
    });
    return { clarifyAttempted: true };
  }
};
