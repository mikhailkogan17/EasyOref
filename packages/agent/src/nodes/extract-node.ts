/**
 * Extract Node — LLM extraction from relevant channels.
 *
 * Skips channels whose sourceUrl already appears in state.previousInsights
 * to avoid re-extracting data from the same source across phases.
 */

import * as logger from "@easyoref/monitoring";
import { Insight } from "@easyoref/shared";
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

const extractionAgentOpts = {
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

// --- Node ---

export const extractNode = async (
  state: AgentStateType,
): Promise<Partial<AgentStateType>> => {
  if (!state.tracking || state.tracking.channelsWithUpdates.length === 0) {
    logger.info("extract-node: no updates to extract", {
      hasTracking: !!state.tracking,
    });
    return {
      messages: [new AIMessage("extract-node: no updates to extract")],
    };
  }

  // Collect URLs already covered by previousInsights to avoid re-extraction
  const seenUrls = new Set<string>(
    (state.previousInsights ?? []).flatMap((vi) =>
      (vi.sources ?? []).map((s) => s.sourceUrl ?? "").filter(Boolean),
    ),
  );

  // Filter out channels where all messages are already extracted
  const channelsToProcess = state.tracking.channelsWithUpdates.filter(
    (ch) =>
      ch.unprocessedMessages.some(
        (m) => !m.sourceUrl || !seenUrls.has(m.sourceUrl),
      ),
  );

  if (channelsToProcess.length === 0) {
    logger.info("extract-node: all channels already covered by previousInsights", {
      seenUrls: seenUrls.size,
      totalChannels: state.tracking.channelsWithUpdates.length,
    });
    return {
      messages: [
        new AIMessage(
          "extract-node: all channels already covered by previousInsights",
        ),
      ],
    };
  }

  let phaseSpecificRule: string;
  switch (state.alertType) {
    case "early_warning":
      phaseSpecificRule =
        "Focus on country_origin, eta_refined_minutes, rocket_count, is_cassette. NOT: intercepted, hits, casualties.";
      break;
    case "red_alert":
      phaseSpecificRule =
        "Focus on country_origin, rocket_count, intercepted, sea_impact, open_area_impact. NOT: hits, casualties.";
      break;
    case "resolved":
      phaseSpecificRule = "Prioritize reports with exact numbers or locations.";
      break;
    default:
      phaseSpecificRule = "Extract all relevant information about the attack.";
      break;
  }

  logger.info("extract-node: sending to LLM", {
    channelsToProcess: channelsToProcess.length,
    channelPreviews: channelsToProcess.map((ch) => ({
      channel: ch.channel,
      msgCount: ch.unprocessedMessages.length,
      firstMsgPreview: ch.unprocessedMessages[0]?.text?.slice(0, 120) ?? "",
    })),
  });

  const messages: BaseMessage[] = [];
  messages.push(new SystemMessage(phaseSpecificRule));
  messages.push(
    new HumanMessage(JSON.stringify(channelsToProcess)),
  );

  const result = await invokeWithFallback({
    agentOpts: extractionAgentOpts,
    fallbackModel: extractFallback,
    input: { messages },
    label: "extract-node",
  });
  const extracted = result.structuredResponse ?? [];
  messages.push(new AIMessage(JSON.stringify(extracted)));

  logger.info("extract-node: extraction done", {
    channelsProcessed: channelsToProcess.length,
    insightsExtracted: extracted.length,
    insightKinds: extracted.map((i: { kind?: { kind?: string } }) => i.kind?.kind),
  });

  return {
    messages,
    extractedInsights: extracted,
  };
};
