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

import { Insight } from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import { AIMessage } from "langchain";
import z from "zod";
import { extractModel } from "../../../models.js";
import { extractFromChannel } from "../../../utils/channel-extract.js";
import { getPhaseRule } from "../../../utils/phase-rules.js";
import type { AgentStateType } from "../enrichment-graph.js";

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
4. eta — estimated arrival. Use {kind:"minutes", minutes:N} OR {kind:"exact_time", exactTime:"HH:MM:SS"} when the post states a clock time (e.g. 14:55). Extract ETA in the SAME pass as other facts from that post — never skip ETA because you already extracted country_origins.
5. cluser_munition_used — cluster / cassette munition (Hebrew מצרר, קסד"ת, רסס וכו'). kind: {kind:"cluser_munition_used", value:true}
6. casualities — casualties OR explicit "no casualties" report. kind: {kind:"casualities", value:[{count:2, level:"death", cause:"rocket"}]}. When a source explicitly states "no casualties" / "no injuries" / "MADA: no reports of injured" → extract {kind:"casualities", value:[{count:0, cause:"rocket"}]}. Only extract count=0 when the source EXPLICITLY says so; do not assume.

FOR EACH INSIGHT also set:
- timeRelevance: 1.0 if about THIS attack, 0.2 if generic news, 0 if old
- regionRelevance: 1.0 if about alert area, 0.5 if about Israel generally
- confidence: 0.5-1.0 based on source reliability
- source: copy the NewsMessage object from the post you extracted from (channelId, sourceType, timestamp, text, sourceUrl)
- timeStamp: ISO 8601 string of extraction time

RULES:
- Extract ONLY facts explicitly stated in the text. Never guess.
- ALWAYS extract ETA if any time reference (minutes until impact, or clock time HH:MM) appears. ETA is critical; missing it when the text states a time is a failure.
- CRITICAL — ETA must be about time-to-impact for THIS attack, NOT inter-attack intervals. Phrases like "within less than an hour" / "בתוך פחות משעה" / "again within X minutes" describing how soon ANOTHER attack happened are NOT ETA. Only extract ETA when the text gives a concrete arrival time for missiles currently in the air.
- CRITICAL — מצרר vs Egypt: Hebrew "מצרר" (cluster munition) is NOT "מצרים" (Egypt). Do NOT output country_origins "Egypt" / "מצרים" unless the text clearly names Egypt as the launch origin. If the text has מצרר, prefer cluser_munition_used: true instead.
- If the text states both an origin country and a time, output separate insights for each (do not drop one).
- If a post says "about 30 rockets" → rocket_count {type:"exact",value:30}
- If a post says "most intercepted" → impact {interceptionsCount:{type:"most"}}
- One insight per fact. Multiple facts from one post = multiple insights.
- Return [] if no extractable military facts found.
`,
};

// --- Single-channel extraction node (invoked via Send() fan-out) ---

export const extractChannelNode = async (
  state: AgentStateType,
): Promise<Partial<AgentStateType>> => {
  const channel = state.channelToExtract;

  if (!channel) {
    logger.warn("extract-channel: no channelToExtract in state — skipping");
    return {
      messages: [
        new AIMessage("extract-channel: no channelToExtract in state"),
      ],
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
      logger.info(
        `extract-channel: ${channel.channel} → ${insights.length} insight(s)`,
        {
          kinds: insights.map(
            (i: { kind?: { kind?: string } }) => i.kind?.kind,
          ),
        },
      );
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
        new AIMessage(
          `extract-channel: ${channel.channel} failed: ${String(err)}`,
        ),
      ],
    };
  }
};
