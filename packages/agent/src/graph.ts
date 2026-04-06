/**
 * LangGraph.js enrichment pipeline — phase-aware, time-validated.
 *
 * ┌─────────┐    ┌───────────────────────────────┐    ┌─────────┐    ┌───────────────┐
 * │ filter  │───▶│ fanOutExtract (conditional)    │───▶│  vote   │───▶│ shouldClarify │
 * └─────────┘    │  ├─ extract-channel ×1         │    └─────────┘    └──────┬────────┘
 *                │  ├─ extract-channel ×2         │                          │
 *                │  └─ extract-channel ×N (Send)  │          ┌───────────────┴──────────┐
 *                └──────────────┬──────────────────┘          │                          │
 *                               │                        [low conf]                 [high conf]
 *                               ▼                             │                          │
 *                         ┌─────────────┐                     ▼                          ▼
 *                         │ post-filter │              ┌────────────┐               ┌─────────┐
 *                         └─────────────┘              │  clarify   │               │   edit  │
 *                                                      └──────┬─────┘               └─────────┘
 *                                                             │                          ▲
 *                                                             ▼                          │
 *                                                      ┌────────────┐                    │
 *                                                      │   revote   │────────────────────┘
 *                                                      └────────────┘
 *
 * ── Node responsibilities ──────────────────────────────────────────────────
 *
 * filter:     Collect Telegram posts from Redis, apply deterministic noise
 *             filters (area lists, summaries, IDF press releases). Returns
 *             ChannelTrackingType structure.
 *
 * extract-channel: Single-channel LLM extraction node (invoked N times via
 *             Send() fan-out from fanOutExtract conditional edge). Each
 *             invocation reads state.channelToExtract and returns insights
 *             for that one channel. Failures are isolated per-channel.
 *
 * post-filter: Deterministic validation of extracted insights.
 *
 * vote:       Consensus voting (deterministic, 0 tokens). Aggregates multiple
 *             extractions into a single VotedResult using median/majority.
 *
 * shouldClarify: Conditional routing:
 *             - Low confidence (< threshold) → clarify
 *             - Single-source Lebanon for central Israel → clarify (suspicious)
 *             - Already clarified → edit
 *             - MCP tools disabled → edit
 *
 * clarify:    ReAct agent with tools (read_telegram, alert_history,
 *             resolve_area, betterstack_log). Fetches more data to resolve
 *             contradictions. Output: new extractions.
 *
 * revote:     Re-run vote with additional extractions from clarify.
 *
 * edit:       Build enriched message text and edit Telegram message.
 *
 * ── Why this pipeline? ─────────────────────────────────────────────────────
 *
 * 1. Send() fan-out: Each channel is extracted independently and in parallel
 *    at the graph level. One channel failure doesn't lose data from others.
 *    The ReducedValue reducer on extractedInsights auto-merges results.
 *
 * 2. ReAct clarification: Low-confidence results aren't "failed" —
 *    they're signals that more data is needed. The LLM decides what tools
 *    to use rather than a hardcoded threshold.
 *
 * 3. Carry-forward: previousEnrichment preserves data between phases.
 *    If origin was confirmed in early_warning, it carries to red_alert/resolved.
 *
 * 4. Time validation: LLM instructions emphasize checking if sources
 *    are about THIS alert vs. previous attacks. Critical for accuracy.
 */

import {
  AlertType,
  ChannelTracking,
  Insight,
  NewsChannelWithUpdates,
  RunEnrichmentInput,
  SynthesizedInsight,
  TelegramMessage,
  ValidatedInsight,
  VotedInsight,
  VotedResult,
  config,
  getVotedInsights,
  validateSafe,
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
import { clarifyNode } from "./nodes/clarify-node.js";
import { editNode } from "./nodes/edit-node.js";
import { extractChannelNode } from "./nodes/extract-node.js";
import { postFilterNode } from "./nodes/post-filter-node.js";
import { filterNode as preFilterNode } from "./nodes/pre-filter-node.js";
import { synthesizeNode } from "./nodes/synthesize-node.js";
import { voteNode } from "./nodes/vote-node.js";

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
  clarifyAttempted: z.boolean().default(false),
  previousInsights: new ReducedValue(z.array(VotedInsight), {
    reducer: (_previous, current) => current, // Replace, not accumulate — only latest phase matters
  }),
  synthesizedInsights: new ReducedValue(z.array(SynthesizedInsight), {
    reducer: (_previous, current) => current,
  }),
  telegramMessages: new ReducedValue(z.array(TelegramMessage), {
    reducer: (previous, current) => [...previous, ...current],
  }),
});

export type AgentStateType = typeof AgentState.State;

const shouldClarify = (state: AgentStateType): "clarify" | "edit" => {
  if (state.clarifyAttempted) return "edit";
  if (!config.agent.mcpTools) return "edit";
  if (!state.votedResult) return "edit";

  // New logic: check if voting determined clarification needed
  if (state.votedResult.needsClarify) {
    return "clarify";
  }

  return "edit";
};

/**
 * Fan-out conditional edge: sends each channel to its own extractChannelNode
 * invocation via LangGraph Send() API for graph-level parallelism.
 *
 * Computes seenUrls from previousInsights to skip already-extracted channels.
 * Returns "post-filter" (string) if no channels need extraction (skip case),
 * or Send[] for parallel fan-out to extract-channel nodes.
 */
const fanOutExtract = (state: AgentStateType): string | Send[] => {
  if (!state.tracking || state.tracking.channelsWithUpdates.length === 0) {
    logger.info("fanOutExtract: no updates to extract", {
      hasTracking: !!state.tracking,
    });
    return "post-filter";
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
    logger.info("fanOutExtract: all channels already covered by previousInsights", {
      seenUrls: seenUrls.size,
      totalChannels: state.tracking.channelsWithUpdates.length,
    });
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

// Checkpointer removed: MemorySaver caused messages to accumulate across
// worker retries (same thread_id), crashing OpenRouter with deserialization
// errors. Carry-forward uses Redis (saveVotedInsights/getVotedInsights).

export const buildGraph = () =>
  new StateGraph(AgentState)
    .addNode("pre-filter", preFilterNode)
    .addNode("extract-channel", extractChannelNode)
    .addNode("post-filter", postFilterNode)
    .addNode("vote", voteNode)
    .addNode("synthesize", synthesizeNode)
    .addNode("clarify", clarifyNode)
    .addNode("revote", voteNode)
    .addNode("edit", editNode)
    .addEdge(START, "pre-filter")
    .addConditionalEdges("pre-filter", fanOutExtract)
    .addEdge("extract-channel", "post-filter")
    .addEdge("post-filter", "vote")
    .addEdge("vote", "synthesize")
    .addConditionalEdges("synthesize", shouldClarify, {
      clarify: "clarify",
      edit: "edit",
    })
    .addEdge("clarify", "revote")
    .addEdge("revote", "synthesize")
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
        logger.warn("runEnrichment: carry-forward insights failed validation — starting fresh", {
          error: parsed.error.message.slice(0, 200),
        });
      }
    } catch (redisErr) {
      logger.warn("runEnrichment: failed to load carry-forward insights from Redis", {
        error: String(redisErr).slice(0, 200),
      });
    }
    if (previousInsights.length > 0) {
      logger.info("runEnrichment: loaded carry-forward insights from Redis", {
        count: previousInsights.length,
        kinds: previousInsights.map((vi) => vi.kind.kind),
      });
    }

    const result = await buildGraph().invoke(
      {
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
      },
    );

    // Terminal guard: warn if entire pipeline produced zero content
    const synthesized = result?.synthesizedInsights ?? [];
    if (synthesized.length === 0) {
      logger.warn("runEnrichment: pipeline completed with ZERO synthesized insights", {
        alertId: validInput.alertId,
        alertType: validInput.alertType,
      });
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
