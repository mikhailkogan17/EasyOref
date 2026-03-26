/**
 * LangGraph.js enrichment pipeline — phase-aware, time-validated.
 *
 * ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌──────────---──┐
 * │ filter  │───▶│ extract │───▶│  vote   │───▶│ shouldClarify │
 * └─────────┘    └─────────┘    └─────────┘    └──────┬───---──┘
 *                                                     │
 *                                      ┌──────────────┴──────────────┐
 *                                      │                             │
 *                                 [low conf]                    [high conf]
 *                                      │                             │
 *                                      ▼                             ▼
 *                               ┌────────────┐                  ┌─────────┐
 *                               │  clarify   │                  │   edit  │
 *                               └──────┬─────┘                  └─────────┘
 *                                      │                             ▲
 *                                      ▼                             │
 *                               ┌────────────┐                       │
 *                               │   revote   │───────────────────────┘
 *                               └────────────┘
 *
 * ── Node responsibilities ──────────────────────────────────────────────────
 *
 * filter:     Collect Telegram posts from Redis, apply deterministic noise
 *             filters (area lists, summaries, IDF press releases). Returns
 *             ChannelTrackingType structure.
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
 *    If origin was confirmed in early_warning, it carries to red_alert/resolved.
 *
 * 4. Time validation: LLM instructions emphasize checking if sources
 *    are about THIS alert vs. previous attacks. Critical for accuracy.
 */

import {
  AlertType,
  ChannelTracking,
  Insight,
  RunEnrichmentInput,
  SynthesizedInsight,
  TelegramMessage,
  ValidatedInsight,
  VotedInsight,
  VotedResult,
  config,
  validateSafe,
} from "@easyoref/shared";
import {
  END,
  MemorySaver,
  MessagesValue,
  ReducedValue,
  START,
  StateGraph,
  StateSchema,
} from "@langchain/langgraph";
import { z } from "zod";
import { clarifyNode } from "./nodes/clarify-node.js";
import { editNode } from "./nodes/edit-node.js";
import { extractNode } from "./nodes/extract-node.js";
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
  monitoringLabel: z.string().optional(),
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

const checkpointer = new MemorySaver();

export const buildGraph = () =>
  new StateGraph(AgentState)
    .addNode("pre-filter", preFilterNode)
    .addNode("extract", extractNode)
    .addNode("post-filter", postFilterNode)
    .addNode("vote", voteNode)
    .addNode("synthesize", synthesizeNode)
    .addNode("clarify", clarifyNode)
    .addNode("revote", voteNode)
    .addNode("edit", editNode)
    .addEdge(START, "pre-filter")
    .addEdge("pre-filter", "extract")
    .addEdge("extract", "post-filter")
    .addEdge("post-filter", "vote")
    .addEdge("vote", "synthesize")
    .addConditionalEdges("synthesize", shouldClarify, {
      clarify: "clarify",
      edit: "edit",
    })
    .addEdge("clarify", "revote")
    .addEdge("revote", "synthesize")
    .addEdge("edit", END)
    .compile({ checkpointer });

export type { RunEnrichmentInputType } from "@easyoref/shared";
export { RunEnrichmentInput };

export const runEnrichment = async (input: unknown): Promise<void> => {
  const validation = validateSafe(RunEnrichmentInput, input);
  if (!validation.ok) {
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
      previousInsights: [],
      monitoringLabel: validInput.monitoringLabel,
    },
    { configurable: { thread_id: validInput.alertId } },
  );
};
