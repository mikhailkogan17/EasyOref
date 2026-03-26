/**
 * LLM models configuration with LangSmith tracing support.
 *
 * LangSmith tracing requires setting environment variables:
 * - LANGCHAIN_TRACING=true
 * - LANGCHAIN_API_KEY=your_key
 * - LANGCHAIN_PROJECT=easyoref
 *
 * Or configure via config.yaml ai section.
 */

import { config } from "@easyoref/shared";
import { ChatOpenRouter } from "@langchain/openrouter";

// LangSmith tracing is enabled via environment variables by default in LangChain
// Additional config can be passed via callbacks if needed
// Note: ChatOpenRouter from @langchain/openrouter inherits from BaseChatModel

let callbacksConfig: object = {};

// Try to enable LangSmith if configured
if (config.agent.langsmithApiKey) {
  // Set env vars for LangChain auto-tracing
  process.env.LANGCHAIN_TRACING = "true";
  process.env.LANGCHAIN_API_KEY = config.agent.langsmithApiKey;
  process.env.LANGCHAIN_PROJECT = config.agent.langsmithProject;
  process.env.LANGSMITH_ENDPOINT = "https://api.smith.langchain.com";

  console.log(
    `[models] LangSmith tracing enabled: project=${config.agent.langsmithProject}`,
  );
}

export const preFilterModel = new ChatOpenRouter({
  apiKey: config.agent.apiKey,
  model: config.agent.filterModel,
  temperature: 0,
  maxTokens: 200,
  ...callbacksConfig,
});

/** Free model for cheap yes/no geography checks (resolve_area LLM-fallback) */
export const freeModel = new ChatOpenRouter({
  apiKey: config.agent.apiKey,
  model: "openai/gpt-oss-120b:free",
  temperature: 0,
  maxTokens: 10,
  ...callbacksConfig,
});

export const extractModel = new ChatOpenRouter({
  apiKey: config.agent.apiKey,
  model: config.agent.extractModel,
  temperature: 0,
  maxTokens: 500,
  ...callbacksConfig,
});
