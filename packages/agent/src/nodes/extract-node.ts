/**
 * Extract Node — LLM extraction from relevant channels.
 *
 * Skips channels whose sourceUrl already appears in state.previousInsights
 * to avoid re-extracting data from the same source across phases.
 */

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
  systemPrompt: `You analyze Telegram channel messages about a missile/rocket attack on Israel.
  Extract structured data from the message.
  Set source to the full NewsMessage object of the post you are extracting from.

  CRITICAL — TIME VALIDATION:
  - If post discusses events BEFORE alert time → time_relevance=0
  - If post is generic military news not specific to THIS attack → time_relevance=0.2
  - If post discusses current attack → time_relevance=1.0

  RULES:
  - Only extract concrete numbers explicitly stated. Never guess.
  - Always respect exact qualitative value from source.
  `,
};

// --- Node ---

export const extractNode = async (
  state: AgentStateType,
): Promise<Partial<AgentStateType>> => {
  if (!state.tracking || state.tracking.channelsWithUpdates.length === 0) {
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

  return {
    messages,
    extractedInsights: extracted,
  };
};
