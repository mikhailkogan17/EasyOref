/**
 * QA LangGraph pipeline — RAG-style Q&A using Redis session data + Oref history.
 *
 * ┌────────────────┐    ┌──────────────────┐    ┌───────────────┐
 * │ intent-classify│───▶│  context-gather  │───▶│answer-generate│
 * └────────────────┘    └──────────────────┘    └───────────────┘
 *
 * intent-classify:  Deterministic regex (0 tokens). Categories:
 *                   current_alert | recent_history | general_security | bot_help
 * context-gather:   Redis (active session, voted insights) + Oref history API.
 * answer-generate:  LLM structured answer in user's language.
 */

import { getUser } from "@easyoref/shared";
import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import { answerNode } from "./nodes/answer.js";
import { contextNode } from "./nodes/context.js";
import { intentNode } from "./nodes/intent.js";

export const QaState = new StateSchema({
  userMessage: z.string(),
  chatId: z.string(),
  language: z.string().default("ru"),
  intent: z.string().default("general_security"),
  context: z.string().default(""),
  answer: z.string().default(""),
  sources: z.array(z.string()).default([]),
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
 */
export async function runQa(
  userMessage: string,
  chatId: string,
): Promise<string> {
  const user = await getUser(chatId);
  const language = user?.language ?? "ru";

  const result = await qaGraph.invoke({
    userMessage,
    chatId,
    language,
    intent: "general_security",
    context: "",
    answer: "",
    sources: [],
  });

  return result.answer || "No answer available.";
}
