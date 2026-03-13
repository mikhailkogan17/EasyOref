/**
 * LangGraph.js enrichment pipeline — phase-aware, time-validated.
 *
 * Lean orchestrator: connects filter → extract → vote → edit.
 * All logic lives in dedicated modules:
 *   - filters.ts:  deterministic noise filter, channel tracking
 *   - extract.ts:  cheap LLM pre-filter, expensive extraction, post-filter
 *   - vote.ts:     consensus voting (deterministic)
 *   - message.ts:  message building, Telegram editing
 *   - helpers.ts:  toIsraelTime, textHash
 *
 * Pipeline:
 *   collectAndFilter → extract → vote → [clarify → revote] → editMessage
 */

import { Annotation, MemorySaver, StateGraph } from "@langchain/langgraph";
import { config } from "../config.js";
import * as logger from "../logger.js";
import { runClarify } from "./clarify.js";
import {
  extractPosts,
  filterChannelsCheap,
  postFilter,
  type ExtractContext,
} from "./extract.js";
import { buildChannelTracking } from "./filters.js";
import { editMessage } from "./message.js";
import {
  getActiveSession,
  getChannelPosts,
  getEnrichmentData,
  getLastUpdateTs,
  setLastUpdateTs,
  type ChatMessage,
} from "./store.js";
import type {
  AlertType,
  ChannelTracking,
  EnrichmentData,
  TrackedMessage,
  ValidatedExtraction,
  VotedResult,
} from "./types.js";
import { emptyEnrichmentData } from "./types.js";
import { vote } from "./vote.js";

// ── State ──────────────────────────────────────────────

const AgentState = Annotation.Root({
  alertId: Annotation<string>({ reducer: (_, b) => b }),
  alertTs: Annotation<number>({ reducer: (_, b) => b }),
  alertType: Annotation<AlertType>({ reducer: (_, b) => b }),
  alertAreas: Annotation<string[]>({ reducer: (_, b) => b }),
  chatId: Annotation<string>({ reducer: (_, b) => b }),
  messageId: Annotation<number>({ reducer: (_, b) => b }),
  isCaption: Annotation<boolean>({ reducer: (_, b) => b }),
  currentText: Annotation<string>({ reducer: (_, b) => b }),
  tracking: Annotation<ChannelTracking | null>({ reducer: (_, b) => b }),
  extractions: Annotation<ValidatedExtraction[]>({ reducer: (_, b) => b }),
  votedResult: Annotation<VotedResult | null>({ reducer: (_, b) => b }),
  clarifyAttempted: Annotation<boolean>({ reducer: (_, b) => b }),
  previousEnrichment: Annotation<EnrichmentData>({ reducer: (_, b) => b }),
  monitoringLabel: Annotation<string | undefined>({ reducer: (_, b) => b }),
  chatMessages: Annotation<ChatMessage[] | undefined>({
    reducer: (_, b) => b,
  }),
});

type AgentStateType = typeof AgentState.State;

// ── Node: collect posts + deterministic noise filter ───

async function collectAndFilter(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const posts = await getChannelPosts(state.alertId);
  const prevEnrichment = await getEnrichmentData();
  const session = await getActiveSession();
  const sessionStartTs = session?.sessionStartTs ?? state.alertTs;
  const lastUpdateTs = await getLastUpdateTs();

  if (posts.length === 0) {
    logger.info("Agent: no posts", { alertId: state.alertId });
    return { tracking: null, previousEnrichment: prevEnrichment };
  }

  const tracking = buildChannelTracking(posts, sessionStartTs, lastUpdateTs);

  logger.info("Agent: channel tracking", {
    alertId: state.alertId,
    total_posts: posts.length,
    channels_with_updates: tracking.channels_with_updates.length,
    total_new_posts: tracking.channels_with_updates.reduce(
      (s, c) => s + c.last_tracked_messages.length,
      0,
    ),
  });

  return { tracking, previousEnrichment: prevEnrichment };
}

// ── Node: cheap LLM channel filter + expensive extraction ──

async function extractNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  if (!state.tracking || state.tracking.channels_with_updates.length === 0) {
    logger.info("Agent: no channels with updates", {
      alertId: state.alertId,
    });
    return { extractions: [] };
  }

  // Step 1: cheap LLM — which channels have important military intel?
  const relevantChannels = await filterChannelsCheap(
    state.tracking,
    state.alertAreas,
    state.alertTs,
    state.alertType,
  );

  if (relevantChannels.length === 0) {
    logger.info("Agent: no relevant channels after cheap filter", {
      alertId: state.alertId,
    });
    return { extractions: [] };
  }

  // Step 2: collect posts from relevant channels only
  const postsToExtract: TrackedMessage[] = [];
  for (const ch of state.tracking.channels_with_updates) {
    const match = relevantChannels.some(
      (rc) =>
        rc === ch.channel || rc === `@${ch.channel}` || `@${rc}` === ch.channel,
    );
    if (match) {
      postsToExtract.push(...ch.last_tracked_messages);
    }
  }

  if (postsToExtract.length === 0) {
    logger.info("Agent: no posts from relevant channels", {
      alertId: state.alertId,
    });
    return { extractions: [] };
  }

  // Step 3: expensive extraction with post-level dedup
  const ctx: ExtractContext = {
    alertTs: state.alertTs,
    alertType: state.alertType,
    alertAreas: state.alertAreas,
    alertId: state.alertId,
    language: config.language,
    existingEnrichment: state.previousEnrichment,
  };
  const raw = await extractPosts(postsToExtract, ctx);

  // Step 4: deterministic post-filter
  const filtered = postFilter(raw, state.alertId);

  // Update timestamp for next job's dedup split
  await setLastUpdateTs(Date.now());

  return { extractions: filtered };
}

// ── Node: vote ─────────────────────────────────────────

function voteNode(state: AgentStateType): Partial<AgentStateType> {
  return { votedResult: vote(state.extractions, state.alertId) };
}

// ── Node: clarify (MCP tool calling) ───────────────────

async function clarifyNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  if (!state.votedResult) {
    logger.info("Agent: clarify skipped — no voted result", {
      alertId: state.alertId,
    });
    return { clarifyAttempted: true };
  }

  logger.info("Agent: clarify triggered", {
    alertId: state.alertId,
    confidence: state.votedResult.confidence,
  });

  try {
    const result = await runClarify({
      alertId: state.alertId,
      alertAreas: state.alertAreas,
      alertType: state.alertType,
      alertTs: state.alertTs,
      messageId: state.messageId,
      currentText: state.currentText,
      extractions: state.extractions,
      votedResult: state.votedResult,
    });

    return {
      extractions: [...state.extractions, ...result.newExtractions],
      votedResult: null,
      clarifyAttempted: true,
    };
  } catch (err) {
    logger.error("Agent: clarify failed", {
      alertId: state.alertId,
      error: String(err),
    });
    return { clarifyAttempted: true };
  }
}

// ── Node: edit Telegram message ────────────────────────

async function editNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  await editMessage({
    alertId: state.alertId,
    alertTs: state.alertTs,
    alertType: state.alertType,
    chatId: state.chatId,
    messageId: state.messageId,
    isCaption: state.isCaption,
    chatMessages: state.chatMessages,
    currentText: state.currentText,
    votedResult: state.votedResult,
    previousEnrichment: state.previousEnrichment ?? emptyEnrichmentData(),
    monitoringLabel: state.monitoringLabel,
  });
  return {};
}

// ── Conditional routing after vote ─────────────────────

function shouldClarify(state: AgentStateType): "clarify" | "editMessage" {
  if (state.clarifyAttempted) return "editMessage";
  if (!config.agent.mcpTools) return "editMessage";
  if (!state.votedResult) return "editMessage";

  if (state.votedResult.confidence < config.agent.confidenceThreshold) {
    logger.info("Agent: routing to clarify (low confidence)", {
      confidence: state.votedResult.confidence,
    });
    return "clarify";
  }

  // Suspicious single-source: Lebanon for central Israel → verify
  const origins = state.votedResult.country_origins;
  if (
    origins &&
    origins.length === 1 &&
    state.votedResult.sources_count === 1
  ) {
    if (
      origins[0]!.name === "Lebanon" &&
      state.alertAreas.some(
        (a) =>
          a.includes("תל אביב") ||
          a.includes("גוש דן") ||
          a.includes("שרון") ||
          a.includes("מרכז"),
      )
    ) {
      logger.info("Agent: routing to clarify (suspicious Lebanon origin)", {});
      return "clarify";
    }
  }

  return "editMessage";
}

// ── Build graph ────────────────────────────────────────

const checkpointer = new MemorySaver();

function buildGraph() {
  return new StateGraph(AgentState)
    .addNode("collectAndFilter", collectAndFilter)
    .addNode("extract", extractNode)
    .addNode("vote", voteNode)
    .addNode("clarify", clarifyNode)
    .addNode("revote", voteNode)
    .addNode("editMessage", editNode)
    .addEdge("__start__", "collectAndFilter")
    .addEdge("collectAndFilter", "extract")
    .addEdge("extract", "vote")
    .addConditionalEdges("vote", shouldClarify, {
      clarify: "clarify",
      editMessage: "editMessage",
    })
    .addEdge("clarify", "revote")
    .addEdge("revote", "editMessage")
    .addEdge("editMessage", "__end__")
    .compile({ checkpointer });
}

// ── Public API ─────────────────────────────────────────

export interface RunEnrichmentInput {
  alertId: string;
  alertTs: number;
  alertType: AlertType;
  alertAreas: string[];
  chatId: string;
  messageId: number;
  isCaption: boolean;
  chatMessages?: ChatMessage[];
  currentText: string;
  monitoringLabel?: string;
}

export async function runEnrichment(input: RunEnrichmentInput): Promise<void> {
  await buildGraph().invoke(
    {
      alertId: input.alertId,
      alertTs: input.alertTs,
      alertType: input.alertType,
      alertAreas: input.alertAreas,
      chatId: input.chatId,
      messageId: input.messageId,
      isCaption: input.isCaption,
      chatMessages: input.chatMessages,
      currentText: input.currentText,
      tracking: null,
      extractions: [],
      votedResult: null,
      clarifyAttempted: false,
      previousEnrichment: emptyEnrichmentData(),
      monitoringLabel: input.monitoringLabel,
    },
    { configurable: { thread_id: input.alertId } },
  );
}
