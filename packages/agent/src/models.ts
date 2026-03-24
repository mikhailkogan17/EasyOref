/**
 * LLM models configuration.
 */

import { ChatOpenRouter } from "@langchain/openrouter";
import { config } from "@easyoref/shared";

export const filterModel = new ChatOpenRouter({
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
