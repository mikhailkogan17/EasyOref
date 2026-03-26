/**
 * LLM models configuration with LangSmith tracing support.
 *
 * LangSmith tracing requires setting environment variables:
 * - LANGSMITH_TRACING=true
 * - LANGSMITH_API_KEY=your_key
 * - LANGSMITH_PROJECT=easyoref
 *
 * Or configure via config.yaml ai section.
 *
 * Note: Tracing is enabled in worker.ts when the agent starts.
 */

import { config } from "@easyoref/shared";
import { ChatOpenRouter } from "@langchain/openrouter";

// LangSmith tracing is enabled via environment variables by default in LangChain
// Note: ChatOpenRouter from @langchain/openrouter inherits from BaseChatModel

export const preFilterModel = new ChatOpenRouter({
  apiKey: config.agent.apiKey,
  model: config.agent.filterModel,
  temperature: 0,
  maxTokens: 200,
});

export const extractModel = new ChatOpenRouter({
  apiKey: config.agent.apiKey,
  model: config.agent.extractModel,
  temperature: 0,
  maxTokens: 500,
});

/** Free model for cheap yes/no geography checks (resolve_area LLM-fallback) */
export const freeModel = new ChatOpenRouter({
  apiKey: config.agent.apiKey,
  model: "openai/gpt-oss-120b:free",
  temperature: 0,
  maxTokens: 10,
});