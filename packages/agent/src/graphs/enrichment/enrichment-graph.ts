/**
 * LangGraph.js enrichment pipeline — phase-aware, time-validated.
 *
 * ┌─────────┐    ┌───────────────────────────────┐    ┌─────────────┐    ┌───────────┐    ┌──────┐
 * │ filter  │───▶│ fanOutExtract (conditional)    │───▶│ post-filter │───▶│ synthesize│───▶│ edit │
 * └─────────┘    │  ├─ extract-channel ×1         │    └─────────────┘    └───────────┘    └──────┘
 *                │  ├─ extract-channel ×2         │
 *                │  └─ extract-channel ×N (Send)  │
 *                └────────────────────────────────┘
 *
 * ── Node responsibilities ──────────────────────────────────────────────────
 *
 * filter:     Collect Telegram posts from Redis, apply deterministic noise
 *             filters. Returns ChannelTrackingType structure.
 *
 * extract-channel: Single-channel LLM extraction (invoked N times via Send()
 *             fan-out). Each reads state.channelToExtract, returns insights.
 *
 * post-filter: LLM verification of extracted insights against source text.
 *
 * synthesize: Deterministic consensus voting (0 tokens) + LLM synthesis.
 *             Picks best insight per kind, produces localized display values.
 *
 * edit:       Build enriched message text and edit Telegram message.
 */

import {
  AlertType,
  ChannelTracking,
  getVotedInsights,
  Insight,
  NewsChannelWithUpdates,
  RunEnrichmentInput,
  SynthesizedInsight,
  TelegramMessage,
  ValidatedInsight,
  validateSafe,
  VotedInsight,
  VotedResult,
} from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import {
  END,
  MessagesValue,
  ReducedValue,
  Send,
  START,
  StateGraph,
  StateSchema,
} from "@langchain/langgraph";
import { z } from "zod";
import { editNode } from "./nodes/edit.js";
import { extractChannelNode } from "./nodes/extract.js";
import { postFilterNode } from "./nodes/post-filter.js";
import { filterNode as preFilterNode } from "./nodes/pre-filter.js";
import { synthesizeNode } from "./nodes/synthesize.js";

export const AgentState = new StateSchema({
  messages: MessagesValue,
  alertId: z.string(),
  alertTs: z.number(),
  alertType: AlertType,
  alertAreas: z.array(z.string()),
  chatId: z.string(),
  messageId: z.number(),
  isCaption: z.boolean(),
  currentText: z.string(),
  tracking: ChannelTracking.optional(),
  channelToExtract: NewsChannelWithUpdates.optional(),
  extractedInsights: new ReducedValue(z.array(Insight), {
    reducer: (previous, current) => [...previous, ...current],
  }),
  filteredInsights: new ReducedValue(z.array(ValidatedInsight), {
    reducer: (previous, current) => [...previous, ...current],
  }),
  votedResult: VotedResult.optional(),
  previousInsights: new ReducedValue(z.array(VotedInsight), {
    reducer: (_previous, current) => current,
  }),
  synthesizedInsights: new ReducedValue(z.array(SynthesizedInsight), {
    reducer: (_previous, current) => current,
  }),
  telegramMessages: new ReducedValue(z.array(TelegramMessage), {
    reducer: (previous, current) => [...previous, ...current],
  }),
});

export type AgentStateType = typeof AgentState.State;

/**
 * Fan-out conditional edge: sends each channel to its own extractChannelNode
 * invocation via LangGraph Send() API for graph-level parallelism.
 *
 * Computes seenUrls from previousInsights to skip already-extracted channels.
 */
const fanOutExtract = (state: AgentStateType): string | Send[] => {
  if (!state.tracking || state.tracking.channelsWithUpdates.length === 0) {
    logger.info("fanOutExtract: no updates to extract", {
      hasTracking: !!state.tracking,
    });
    return "post-filter";
  }

  const seenUrls = new Set<string>(
    (state.previousInsights ?? []).flatMap((vi) =>
      (vi.sources ?? []).map((s) => s.sourceUrl ?? "").filter(Boolean),
    ),
  );

  const channelsToProcess = state.tracking.channelsWithUpdates.filter((ch) =>
    ch.unprocessedMessages.some(
      (m) => !m.sourceUrl || !seenUrls.has(m.sourceUrl),
    ),
  );

  if (channelsToProcess.length === 0) {
    logger.info(
      "fanOutExtract: all channels already covered by previousInsights",
      {
        seenUrls: seenUrls.size,
        totalChannels: state.tracking.channelsWithUpdates.length,
      },
    );
    return "post-filter";
  }

  logger.info("fanOutExtract: fanning out extraction", {
    channelsToProcess: channelsToProcess.length,
    channels: channelsToProcess.map((ch) => ch.channel),
  });

  return channelsToProcess.map(
    (ch) => new Send("extract-channel", { channelToExtract: ch }),
  );
};

export const buildGraph = () =>
  new StateGraph(AgentState)
    .addNode("pre-filter", preFilterNode)
    .addNode("extract-channel", extractChannelNode)
    .addNode("post-filter", postFilterNode)
    .addNode("synthesize", synthesizeNode)
    .addNode("edit", editNode)
    .addEdge(START, "pre-filter")
    .addConditionalEdges("pre-filter", fanOutExtract)
    .addEdge("extract-channel", "post-filter")
    .addEdge("post-filter", "synthesize")
    .addEdge("synthesize", "edit")
    .addEdge("edit", END)
    .compile();

export type { RunEnrichmentInputType } from "@easyoref/shared";
export { RunEnrichmentInput };

export const runEnrichment = async (input: unknown): Promise<void> => {
  const validation = validateSafe(RunEnrichmentInput, input);
  if (!validation.ok) {
    throw new Error(`Invalid enrichment input: ${validation.error}`);
  }

  const validInput = validation.data;

  try {
    // Load carry-forward insights from previous enrichment runs (persisted in Redis)
    // Defensive: re-validate after JSON round-trip to catch schema drift
    let previousInsights: z.infer<typeof VotedInsight>[] = [];
    try {
      const raw = await getVotedInsights();
      const parsed = z.array(VotedInsight).safeParse(raw);
      if (parsed.success) {
        previousInsights = parsed.data;
      } else {
        logger.warn(
          "runEnrichment: carry-forward insights failed validation — starting fresh",
          {
            error: parsed.error.message.slice(0, 200),
          },
        );
      }
    } catch (redisErr) {
      logger.warn(
        "runEnrichment: failed to load carry-forward insights from Redis",
        {
          error: String(redisErr).slice(0, 200),
        },
      );
    }
    if (previousInsights.length > 0) {
      logger.info("runEnrichment: loaded carry-forward insights from Redis", {
        count: previousInsights.length,
        kinds: previousInsights.map((vi) => vi.kind.kind),
      });
    }

    const result = await buildGraph().invoke({
      alertId: validInput.alertId,
      alertTs: validInput.alertTs,
      alertType: validInput.alertType,
      alertAreas: validInput.alertAreas,
      chatId: validInput.chatId,
      messageId: validInput.messageId,
      isCaption: validInput.isCaption,
      telegramMessages: validInput.telegramMessages,
      currentText: validInput.currentText,
      previousInsights,
    });

    // Terminal guard: warn if entire pipeline produced zero content
    const synthesized = result?.synthesizedInsights ?? [];
    if (synthesized.length === 0) {
      logger.warn(
        "runEnrichment: pipeline completed with ZERO synthesized insights",
        {
          alertId: validInput.alertId,
          alertType: validInput.alertType,
        },
      );
    }
  } catch (err) {
    logger.error("runEnrichment: graph error", {
      alertId: validInput.alertId,
      error: String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw err;
  }
};
