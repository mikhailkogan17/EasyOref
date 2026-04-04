/**
 * Extract Node — single-channel LLM extraction.
 *
 * v1.27.7: Refactored to use LangGraph Send() API for graph-level parallelism.
 * Each channel is extracted by a separate `extractChannelNode` invocation,
 * fanned out via `fanOutExtract` conditional edge in graph.ts.
 *
 * This node reads `state.channelToExtract` (a single NewsChannelWithUpdates)
 * and returns extracted insights for that one channel.
 */

import * as logger from "@easyoref/monitoring";
import { Insight, type NewsChannelWithUpdatesType } from "@easyoref/shared";
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
} from "langchain";
import z from "zod";
import type { AgentStateType } from "../graph.js";
import { extractFallback, extractModel, invokeWithFallback } from "../models.js";

// --- Agent options (reused for primary + fallback) ---

export const extractionAgentOpts = {
  model: extractModel,
  responseFormat: z.array(Insight),
  systemPrompt: `You extract structured military intel from Telegram messages about a missile/rocket attack on Israel.
Return an array of Insight objects. Each insight has ONE kind from these options:

KINDS YOU CAN EXTRACT:
1. country_origins — where rockets were launched FROM. kind: {kind:"country_origins", value:["Iran"]} or ["Lebanon","Syria"]
2. rocket_count — how many rockets. kind: {kind:"rocket_count", value:{type:"exact",value:30}} or {type:"more_than",value:20}
3. impact — interceptions/hits. kind: {kind:"impact", value:{interceptionsCount:{type:"most"}, seaFallsCount:{type:"few"}}}
4. eta — estimated arrival. kind: {kind:"eta", value:{kind:"minutes", minutes:12}}
5. cluser_munition_used — cluster munition. kind: {kind:"cluser_munition_used", value:true}
6. casualities — casualties. kind: {kind:"casualities", value:[{count:2, level:"death", cause:"rocket"}]}

FOR EACH INSIGHT also set:
- timeRelevance: 1.0 if about THIS attack, 0.2 if generic news, 0 if old
- regionRelevance: 1.0 if about alert area, 0.5 if about Israel generally
- confidence: 0.5-1.0 based on source reliability
- source: copy the NewsMessage object from the post you extracted from (channelId, sourceType, timestamp, text, sourceUrl)
- timeStamp: ISO 8601 string of extraction time

RULES:
- Extract ONLY facts explicitly stated in the text. Never guess.
- If a post says "about 30 rockets" → rocket_count {type:"exact",value:30}
- If a post says "most intercepted" → impact {interceptionsCount:{type:"most"}}
- One insight per fact. Multiple facts from one post = multiple insights.
- Return [] if no extractable military facts found.
`,
};

// --- Phase-specific extraction rules ---

export function getPhaseRule(alertType: string): string {
  switch (alertType) {
    case "early_warning":
      return "Focus on country_origins, eta, rocket_count, cluser_munition_used. Do NOT extract impact, hits, or casualities in this early phase.";
    case "red_alert":
      return "Focus on country_origins, rocket_count, impact (interceptions, sea falls, open area falls). Do NOT extract casualities or detailed hits yet.";
    case "resolved":
      return "Extract ALL insight kinds: country_origins, rocket_count, impact (interceptions, hits, sea/open area falls), cluser_munition_used, casualities. Prioritize reports with exact numbers or locations.";
    default:
      return "Extract all relevant information about the attack.";
  }
}

// --- Per-channel extraction helper ---

export async function extractFromChannel(
  channel: NewsChannelWithUpdatesType,
  phaseSpecificRule: string,
): Promise<{ channel: string; insights: z.infer<typeof Insight>[] }> {
  const messages: BaseMessage[] = [];
  messages.push(new SystemMessage(phaseSpecificRule));
  messages.push(new HumanMessage(JSON.stringify(channel)));

  const result = await invokeWithFallback({
    agentOpts: extractionAgentOpts,
    fallbackModel: extractFallback,
    input: { messages },
    label: `extract-node:${channel.channel}`,
  });

  const insights = result.structuredResponse ?? [];
  return { channel: channel.channel, insights };
}

// --- Single-channel extraction node (invoked via Send() fan-out) ---

export const extractChannelNode = async (
  state: AgentStateType,
): Promise<Partial<AgentStateType>> => {
  const channel = state.channelToExtract;

  if (!channel) {
    logger.warn("extract-channel: no channelToExtract in state — skipping");
    return {
      messages: [new AIMessage("extract-channel: no channelToExtract in state")],
    };
  }

  const phaseSpecificRule = getPhaseRule(state.alertType);

  logger.info(`extract-channel: extracting from ${channel.channel}`, {
    msgCount: channel.unprocessedMessages.length,
    firstMsgPreview: channel.unprocessedMessages[0]?.text?.slice(0, 120) ?? "",
  });

  try {
    const { insights } = await extractFromChannel(channel, phaseSpecificRule);

    if (insights.length > 0) {
      logger.info(`extract-channel: ${channel.channel} → ${insights.length} insight(s)`, {
        kinds: insights.map((i: { kind?: { kind?: string } }) => i.kind?.kind),
      });
    } else {
      logger.info(`extract-channel: ${channel.channel} → 0 insights`);
    }

    return {
      messages: [new AIMessage(JSON.stringify(insights))],
      extractedInsights: insights,
    };
  } catch (err) {
    logger.error(`extract-channel: ${channel.channel} failed`, {
      error: String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });

    // Return empty — one channel failure doesn't kill the pipeline
    return {
      messages: [
        new AIMessage(`extract-channel: ${channel.channel} failed: ${String(err)}`),
      ],
    };
  }
};
