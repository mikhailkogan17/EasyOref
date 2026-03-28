/**
 * Clarify Node — optional ReAct tool calling for low-confidence enrichment.
 *
 * Uses describeContradictions (utils/contradictions) to build the user prompt.
 * Records full conversation in state.messages.
 */

import {
  ClarifyOutput,
  pushSessionPost,
  type ValidatedInsightType,
} from "@easyoref/shared";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  createAgent,
  toolStrategy,
} from "langchain";
import type { AgentStateType } from "../graph.js";
import { preFilterFallback, preFilterModel } from "../models.js";
import { clarifyTools } from "../tools/index.js";
import { describeContradictions } from "../utils/contradictions.js";
import * as logger from "@easyoref/monitoring";

const clarifyAgentOpts = {
  model: preFilterModel,
  tools: clarifyTools,
  responseFormat: toolStrategy(ClarifyOutput),
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
};

export const clarifyNode = async (
  state: AgentStateType,
): Promise<Partial<AgentStateType>> => {
  if (!state.votedResult) {
    return {
      messages: [new AIMessage("clarify-node: skipped — no voted result")],
      clarifyAttempted: true,
    };
  }

  const contradictions = describeContradictions(state.votedResult.insights);

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
    `  Insights: ${state.votedResult.insights.length}\n` +
    `  Needs clarification: ${state.votedResult.needsClarify}\n` +
    `  Timestamp: ${new Date(state.votedResult.timestamp).toISOString()}\n` +
    `\n\nContradictions & issues:\n${contradictions}\n\n` +
    `Consensus insights:\n` +
    Object.entries(state.votedResult.consensus)
      .map(
        ([kind, vi]) =>
          `  [${kind}] confidence=${vi.confidence.toFixed(2)}, ` +
          `sourceTrust=${vi.sourceTrust.toFixed(2)}, ` +
          `sources=${vi.sources.map((s) => s.sourceUrl ?? s.channelId).join(", ")}`,
      )
      .join("\n") +
    (state.previousInsights.length > 0
      ? `\n\nCarry-forward from previous phase (${state.previousInsights.length} insights):\n` +
        state.previousInsights
          .map(
            (vi) =>
              `  [${vi.kind.kind}] confidence=${vi.confidence.toFixed(2)}, ` +
              `sources=${vi.sources.map((s) => s.sourceUrl ?? s.channelId).join(", ")}`,
          )
          .join("\n")
      : "") +
    `\n\nDecide: would fetching more data from authoritative channels resolve these issues?`;

  const messages: BaseMessage[] = [new HumanMessage(userPrompt)];

  try {
    // Try primary model first, then fallback
    let result: any;
    try {
      const agent = createAgent(clarifyAgentOpts as any);
      result = await agent.invoke({ messages });
    } catch (primaryErr) {
      logger.warn("clarify-node: primary model failed, trying fallback", {
        error: String(primaryErr),
      });
      const fallbackAgent = createAgent({
        ...clarifyAgentOpts,
        model: preFilterFallback,
      } as any);
      result = await fallbackAgent.invoke({ messages });
    }
    const output = result.structuredResponse;
    messages.push(new AIMessage(JSON.stringify(output ?? {})));

    const newInsights = (output?.newInsights as ValidatedInsightType[] | undefined) ?? [];

    // Store new posts to session if any
    if (output?.newPosts) {
      for (const p of output.newPosts) {
        await pushSessionPost(p as any).catch(() => {});
      }
    }

    return {
      messages,
      filteredInsights: [...(state.filteredInsights ?? []), ...newInsights],
      votedResult: undefined,
      clarifyAttempted: true,
    };
  } catch (err) {
    messages.push(new AIMessage(JSON.stringify({ error: String(err) })));
    return {
      messages,
      clarifyAttempted: true,
    };
  }
};
