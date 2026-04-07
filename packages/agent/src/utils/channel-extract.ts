/** Per-channel LLM extraction helper. */
import type { NewsChannelWithUpdatesType } from "@easyoref/shared";
import { Insight } from "@easyoref/shared";
import { type BaseMessage, HumanMessage, SystemMessage } from "langchain";
import type z from "zod";
import { extractFallback, invokeWithFallback } from "../models.js";
import { extractionAgentOpts } from "../graphs/enrichment/nodes/extract.js";

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
