/**
 * LangGraph.js enrichment pipeline — phase-aware, time-validated.
 *
 * ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌────────────┐
 * │ filter  │───▶│ extract │───▶│  vote   │───▶│ shouldClarify│
 * └─────────┘    └─────────┘    └─────────┘    └──────┬─────┘
 *                                                         │
 *                                          ┌──────────────┴──────────────┐
 *                                          │                               │
 *                                     [low conf]                    [high conf]
 *                                          │                               │
 *                                          ▼                               ▼
 *                                   ┌────────────┐              ┌─────────┐
 *                                   │  clarify   │              │   edit  │
 *                                   └──────┬─────┘              └─────────┘
 *                                          │                            ▲
 *                                          ▼                            │
 *                                   ┌────────────┐              ┌─────────┐
 *                                   │   revote   │──────────────┘
 *                                   └────────────┘
 *
 * ── Node responsibilities ──────────────────────────────────────────────────
 *
 * filter:     Collect Telegram posts from Redis, apply deterministic noise
 *             filters (area lists, summaries, IDF press releases). Returns
 *             ChannelTracking structure.
 *
 * extract:    LLM-powered extraction pipeline:
 *             1. Cheap model → which channels have relevant intel?
 *             2. Expensive model → extract structured data per post
 *             3. Post-filter → deterministic validation
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
 * 1. Cheap → Expensive: Saves tokens. Pre-filter with cheap model ($0.001)
 *    before spending on per-post extraction ($0.01 each).
 *
 * 2. ReAct clarification: Low-confidence results aren't "failed" —
 *    they're signals that more data is needed. The LLM decides what tools
 *    to use rather than a hardcoded threshold.
 *
 * 3. Carry-forward: previousEnrichment preserves data between phases.
 *    If origin was confirmed in early_warning, it carries to siren/resolved.
 *
 * 4. Time validation: LLM instructions emphasize checking if sources
 *    are about THIS alert vs. previous attacks. Critical for accuracy.
 */

import * as logger from "@easyoref/monitoring";
import {
  AlertTypeSchema,
  ChannelTrackingSchema,
  EnrichmentDataSchema,
  RunEnrichmentInputSchema,
  TelegramMessageSchema,
  ValidatedExtractionSchema,
  VotedResultSchema,
  config,
  createEmptyEnrichmentData,
  validateSafe,
} from "@easyoref/shared";
import {
  END,
  MemorySaver,
  ReducedValue,
  START,
  StateGraph,
  StateSchema,
} from "@langchain/langgraph";
import { z } from "zod";
import { clarifyNode } from "./nodes/clarify-node.js";
import { extractNode } from "./nodes/extract-node.js";
import { filterNode } from "./nodes/filter-node.js";
import { editNode } from "./nodes/message-node.js";
import { voteNode } from "./nodes/vote-node.js";

export const AgentState = new StateSchema({
  alertId: z.string(),
  alertTs: z.number(),
  alertType: AlertTypeSchema,
  alertAreas: z.array(z.string()),
  chatId: z.string(),
  messageId: z.number(),
  isCaption: z.boolean(),
  currentText: z.string(),
  tracking: ChannelTrackingSchema.optional(),
  extractions: new ReducedValue(z.array(ValidatedExtractionSchema), {
    reducer: (previous, current) => [...previous, ...current],
  }),
  votedResult: VotedResultSchema.optional(),
  clarifyAttempted: z.boolean().default(false),
  previousEnrichment: EnrichmentDataSchema.optional(),
  monitoringLabel: z.string().optional(),
  telegramMessages: new ReducedValue(z.array(TelegramMessageSchema), {
    reducer: (previous, current) => [...previous, ...current],
  }),
});

export type AgentStateType = typeof AgentState.State;

const shouldClarify = (state: AgentStateType): "clarify" | "edit" => {
  if (state.clarifyAttempted) return "edit";
  if (!config.agent.mcpTools) return "edit";
  if (!state.votedResult) return "edit";

  if (state.votedResult.confidence < config.agent.confidenceThreshold) {
    logger.info("Agent: routing to clarify (low confidence)", {
      confidence: state.votedResult.confidence,
    });
    return "clarify";
  }

  const origins = state.votedResult.country_origins;
  if (
    origins &&
    origins.length === 1 &&
    state.votedResult.sources_count === 1
  ) {
    if (
      origins[0]!.name === "Lebanon" &&
      state.alertAreas.some(
        (area) =>
          area.includes("תל אביב") ||
          area.includes("גוש דן") ||
          area.includes("שרון") ||
          area.includes("מרכז"),
      )
    ) {
      logger.info("Agent: routing to clarify (suspicious Lebanon origin)", {});
      return "clarify";
    }
  }

  return "edit";
};

const checkpointer = new MemorySaver();

export const buildGraph = () =>
  new StateGraph(AgentState)
    .addNode("filter", filterNode)
    .addNode("extract", extractNode)
    .addNode("vote", voteNode)
    .addNode("clarify", clarifyNode)
    .addNode("revote", voteNode)
    .addNode("edit", editNode)
    .addEdge(START, "filter")
    .addEdge("filter", "extract")
    .addEdge("extract", "vote")
    .addConditionalEdges("vote", shouldClarify, {
      clarify: "clarify",
      edit: "edit",
    })
    .addEdge("clarify", "revote")
    .addEdge("revote", "edit")
    .addEdge("edit", END)
    .compile({ checkpointer });

export type { RunEnrichmentInput } from "@easyoref/shared";
export { RunEnrichmentInputSchema };

export const runEnrichment = async (input: unknown): Promise<void> => {
  const validation = validateSafe(RunEnrichmentInputSchema, input);
  if (!validation.ok) {
    logger.error("Enrichment: invalid input", { error: validation.error });
    throw new Error(`Invalid enrichment input: ${validation.error}`);
  }

  const validInput = validation.data;

  await buildGraph().invoke(
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
      previousEnrichment: createEmptyEnrichmentData(),
      monitoringLabel: validInput.monitoringLabel,
    },
    { configurable: { thread_id: validInput.alertId } },
  );
};
