/**
 * LLM models configuration with free-tier fallback support.
 *
 * Primary and fallback models are fully configured via config.yaml (ai section):
 *   openrouter_filter_model          — cheap channel pre-filter
 *   openrouter_filter_fallback_model — free fallback for filter
 *   openrouter_extract_model         — per-post structured extraction
 *   openrouter_extract_fallback_model — free fallback for extraction
 *
 * IMPORTANT: All models are exported as raw ChatOpenRouter instances.
 * RunnableWithFallbacks (from .withFallbacks()) does NOT support bindTools(),
 * which is required by createAgent() / ReactAgent internally. Fallback logic
 * is handled at the node level via invokeWithFallback() helper.
 */

import { config } from "@easyoref/shared";
import * as logger from "@easyoref/monitoring";
import { ChatOpenRouter } from "@langchain/openrouter";
import { createAgent } from "langchain";

/** Primary pre-filter model (cheap, for channel relevance) */
export const preFilterModel = new ChatOpenRouter({
  apiKey: config.agent.apiKey,
  model: config.agent.filterModel,
  temperature: 0,
  maxTokens: 200,
});

/** Fallback pre-filter model (free auto-router) */
export const preFilterFallback = new ChatOpenRouter({
  apiKey: config.agent.apiKey,
  model: config.agent.filterFallbackModel,
  temperature: 0,
  maxTokens: 200,
});

/**
 * @deprecated Use preFilterModel directly. Kept for backward compat with clarify-node.
 */
export const preFilterModelRaw = preFilterModel;

/** Primary extraction model (per-post structured extraction) */
export const extractModel = new ChatOpenRouter({
  apiKey: config.agent.apiKey,
  model: config.agent.extractModel,
  temperature: 0,
  maxTokens: 500,
});

/** Fallback extraction model (free auto-router) */
export const extractFallback = new ChatOpenRouter({
  apiKey: config.agent.apiKey,
  model: config.agent.extractFallbackModel,
  temperature: 0,
  maxTokens: 500,
});

/** Model for yes/no geography checks (resolve_area LLM-fallback). Pinned to avoid random auto-routing. */
export const freeModel = new ChatOpenRouter({
  apiKey: config.agent.apiKey,
  model: "openai/gpt-oss-120b:free",
  temperature: 0,
  maxTokens: 50,
});

// ── Fallback helper ─────────────────────────────────────────

/**
 * Invoke a createAgent-built agent with automatic fallback to a secondary model.
 *
 * On any error from the primary agent invocation (credits exhausted, rate limit,
 * model unavailable, etc.), rebuilds the agent with the fallback model and retries.
 * This replaces the broken .withFallbacks() approach which is incompatible with
 * createAgent's internal bindTools() call.
 */
export async function invokeWithFallback(opts: {
  /** createAgent options (using primary model) */
  agentOpts: Record<string, any>;
  /** Fallback model to use on primary failure */
  fallbackModel: ChatOpenRouter;
  /** Input to pass to agent.invoke() */
  input: { messages: unknown[] };
  /** Label for logging */
  label: string;
}): Promise<any> {
  const { agentOpts, fallbackModel, input, label } = opts;

  try {
    const agent = createAgent(agentOpts as any);
    return await agent.invoke(input as any);
  } catch (err) {
    logger.warn(`${label}: primary model failed, trying fallback`, {
      error: String(err),
      primaryModel: (agentOpts.model as any)?.model ?? "unknown",
      fallbackModel: fallbackModel.model ?? "unknown",
    });

    try {
      const fallbackAgent = createAgent({ ...agentOpts, model: fallbackModel } as any);
      return await fallbackAgent.invoke(input as any);
    } catch (fallbackErr) {
      logger.error(`${label}: fallback model also failed`, {
        error: String(fallbackErr),
      });
      throw fallbackErr;
    }
  }
}
