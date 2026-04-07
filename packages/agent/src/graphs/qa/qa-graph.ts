/**
 * QA LangGraph pipeline — RAG-style Q&A using Redis session data + Oref history + channel news.
 *
 * ┌────────────────┐    ┌──────────────────┐    ┌───────────────┐
 * │ intent-classify│───▶│  context-gather  │───▶│answer-generate│
 * └────────────────┘    └──────────────────┘    └───────────────┘
 *
 * intent-classify:  Deterministic regex (0 tokens). Categories:
 *                   current_alert | recent_history | general_security | bot_help | off_topic
 * context-gather:   Oref API (current + history) + Redis session + channel posts + enrichment cache.
 *                   Sends status messages via statusCallback if provided.
 * answer-generate:  LLM structured answer in user's language with [[channel]](url) citations.
 *
 * off_topic / bot_help are short-circuited in context-gather (no LLM call).
 */

import { getUser } from "@easyoref/shared";
import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import { answerNode } from "./nodes/answer.js";
import { contextNode } from "./nodes/context.js";
import { intentNode } from "./nodes/intent.js";

/** Callback for sending status messages ("🔎 Searching...") during Q&A processing. */
export type QaStatusCallback = (message: string) => Promise<void>;

export const QaState = new StateSchema({
  userMessage: z.string(),
  chatId: z.string(),
  language: z.string().default("ru"),
  intent: z.string().default("general_security"),
  context: z.string().default(""),
  answer: z.string().default(""),
  sources: z.array(z.string()).default([]),
  /** Pre-fetched Oref history entries (from context node → answer node). */
  history: z.array(z.any()).default([]),
  /** Pre-fetched GramJS session posts (from context node → answer node). */
  posts: z.array(z.any()).default([]),
});

export type QaState = typeof QaState.State;

const buildQaGraph = () =>
  new StateGraph(QaState)
    .addNode("intent-classify", intentNode)
    .addNode("context-gather", contextNode)
    .addNode("answer-generate", answerNode)
    .addEdge(START, "intent-classify")
    .addEdge("intent-classify", "context-gather")
    .addEdge("context-gather", "answer-generate")
    .addEdge("answer-generate", END)
    .compile();

const qaGraph = buildQaGraph();

/**
 * Run the Q&A graph for a user message.
 * Returns a localized answer string in the user's configured language.
 *
 * @param statusCallback - optional callback to send "searching..." status messages to the user
 */
export async function runQa(
  userMessage: string,
  chatId: string,
  statusCallback?: QaStatusCallback,
): Promise<string> {
  const user = await getUser(chatId);
  const language = user?.language ?? "ru";

  const result = await qaGraph.invoke(
    {
      userMessage,
      chatId,
      language,
      intent: "general_security",
      context: "",
      answer: "",
      sources: [],
    },
    { configurable: { statusCallback } },
  );

  return result.answer || "No answer available.";
}
