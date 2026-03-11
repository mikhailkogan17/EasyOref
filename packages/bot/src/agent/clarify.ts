/**
 * Clarify Node — optional ReAct tool calling for low-confidence enrichment.
 *
 * When the voting pipeline produces a result below the confidence threshold,
 * the clarify node gives the LLM access to 4 tools and lets it decide:
 *
 *   - LLM sees the voted result, contradictions, and existing extractions
 *   - LLM MAY call tools if it thinks more data would help
 *   - LLM MAY respond immediately without tools if data is sufficient
 *   - Max 3 tool call iterations, then returns either way
 *
 * Tools:
 *   1. read_telegram_sources — fetch N posts from a Telegram channel
 *   2. alert_history — recent Oref alert history (was there really an alert?)
 *   3. resolve_area — is a mentioned location relevant to user's areas?
 *   4. betterstack_log — query recent EasyOref logs from Better Stack
 *
 * The LLM decides — not a deterministic threshold.
 * Interview answer: "tools are available, agent is autonomous."
 */

import type { AIMessage } from "@langchain/core/messages";
import {
  AIMessage as AIMessageClass,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { ChatOpenAI } from "@langchain/openai";
import { config } from "../config.js";
import * as logger from "../logger.js";
import { pushSessionPost, type ChannelPost } from "./store.js";
import { clarifyTools } from "./tools.js";
import type { ValidatedExtraction, VotedResult } from "./types.js";

// ── Types ──────────────────────────────────────────────

export interface ClarifyInput {
  alertId: string;
  alertAreas: string[];
  alertType: string;
  alertTs: number;
  messageId: number;
  currentText: string;
  extractions: ValidatedExtraction[];
  votedResult: VotedResult;
}

export interface ClarifyOutput {
  /** New posts discovered by tool calls (to merge into session) */
  newPosts: ChannelPost[];
  /** New extractions from tool-fetched posts (to add to existing) */
  newExtractions: ValidatedExtraction[];
  /** Number of tool calls made */
  toolCallCount: number;
  /** Whether clarification gathered useful new data */
  clarified: boolean;
}

// ── Constants ──────────────────────────────────────────

const MAX_REACT_ITERATIONS = 3;

const CLARIFY_SYSTEM_PROMPT = `You are the clarification agent for EasyOref — an Israeli missile alert enrichment system.

The voting pipeline analyzed Telegram channel posts and produced a result with
low confidence or contradictions. You have access to 4 tools:

  1. read_telegram_sources — fetch last N posts from a Telegram news channel
     (IDF, N12, etc). Returns actual message texts.
  2. alert_history — get recent alert history from Pikud HaOref.
     Answers: "was there really an alert in area X in the last N minutes?"
  3. resolve_area — check if a location mentioned in news is relevant to the
     user's monitored areas. Uses defense-zone proximity mapping.
  4. betterstack_log — query recent EasyOref logs from Better Stack.
     See what the enrichment pipeline did recently (extractions, confidence, errors).

CRITICAL — TIME VALIDATION:
You receive the alert time (Israel timezone). Channel posts may be about PREVIOUS
attacks or ongoing military operations (not THIS specific alert). When in doubt:
- Use alert_history to verify if an alert really occurred at the claimed time/area.
- If a post discusses events from hours ago, it is STALE — ignore it.
- If the voted result has a country_origin that seems unlikely for the alert region
  (e.g., "Lebanon" for central Israel) — verify with alert_history and fresh sources.

You decide whether tools would help:
- If contradictions can be resolved with existing data → respond immediately, no tools.
- If an authoritative source (IDF, N12) could settle a disagreement → fetch 1-4 posts.
- If you need to verify whether an alert occurred → check alert_history.
- If news mentions a city/region and you're unsure if it's relevant → use resolve_area.
- If the attack origin seems stale (about a previous event) → use alert_history to verify.
- You can call 0, 1, 2, or 3+ tools. Your choice.

When done (with or without tools), respond with ONLY valid JSON (no markdown):
{
  "clarified": true/false,
  "new_data": {
    "country_origin": string|null,
    "rocket_count": int|null,
    "intercepted": int|null,
    "hits_confirmed": int|null,
    "casualties": int|null,
    "injuries": int|null,
    "is_cassette": bool|null
  },
  "confidence_boost": float,  // 0-0.3 (0 if no new info)
  "reasoning": "brief explanation of decision"
}`;

// ── LLM ───────────────────────────────────────────────

function getClarifyLLM(): ChatOpenAI {
  return new ChatOpenAI({
    model: config.agent.filterModel,
    configuration: {
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/mikhailkogan17/EasyOref",
        "X-Title": "EasyOref-Clarify",
      },
    },
    apiKey: config.agent.apiKey,
    temperature: 0,
    maxTokens: 600,
  });
}

// ── Contradiction detection ───────────────────────────

function describeContradictions(
  extractions: ValidatedExtraction[],
  voted: VotedResult,
): string {
  const issues: string[] = [];

  // Country origin disagreement
  if (voted.country_origins && voted.country_origins.length > 1) {
    const names = voted.country_origins.map((c) => c.name).join(", ");
    issues.push(`Multiple origin countries reported: ${names}`);
  }

  // Rocket count spread
  if (
    voted.rocket_count_min !== null &&
    voted.rocket_count_max !== null &&
    voted.rocket_count_max - voted.rocket_count_min > 3
  ) {
    issues.push(
      `Wide rocket count range: ${voted.rocket_count_min}–${voted.rocket_count_max}`,
    );
  }

  // Low sub-field confidence
  if (voted.intercepted_confidence < 0.5 && voted.intercepted !== null) {
    issues.push(
      `Intercepted count (${
        voted.intercepted
      }) has low confidence: ${voted.intercepted_confidence.toFixed(2)}`,
    );
  }
  if (voted.hits_confidence < 0.5 && voted.hits_confirmed !== null) {
    issues.push(
      `Hits confirmed (${
        voted.hits_confirmed
      }) has low confidence: ${voted.hits_confidence.toFixed(2)}`,
    );
  }

  // Overall
  issues.push(`Overall confidence: ${voted.confidence}`);
  issues.push(`Sources count: ${voted.sources_count}`);

  return issues.join("\n");
}

// ── ReAct loop ────────────────────────────────────────

export async function runClarify(input: ClarifyInput): Promise<ClarifyOutput> {
  const llm = getClarifyLLM();
  const llmWithTools = llm.bindTools(clarifyTools as StructuredToolInterface[]);

  const toolMap = new Map<string, (typeof clarifyTools)[number]>(
    clarifyTools.map((t) => [t.name, t]),
  );

  const contradictions = describeContradictions(
    input.extractions,
    input.votedResult,
  );

  const alertTimeIL = new Date(input.alertTs).toLocaleTimeString("he-IL", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jerusalem",
  });

  const userPrompt =
    `Alert region: ${input.alertAreas.join(", ")}\n` +
    `Alert type: ${input.alertType}\n` +
    `Alert time: ${alertTimeIL} (Israel)\n` +
    `Message ID: ${input.messageId}\n\n` +
    `Current voted result:\n` +
    JSON.stringify(input.votedResult, null, 2) +
    `\n\nContradictions & issues:\n${contradictions}\n\n` +
    `Existing extractions (${
      input.extractions.filter((e) => e.valid).length
    } valid):\n` +
    input.extractions
      .filter((e) => e.valid)
      .map(
        (e) =>
          `  [${e.channel}] country=${e.country_origin}, rockets=${e.rocket_count}, ` +
          `intercepted=${e.intercepted}, hits=${e.hits_confirmed}, conf=${e.confidence}`,
      )
      .join("\n") +
    `\n\nDecide: would fetching more data from authoritative channels or ` +
    `the official API resolve these issues? If not, respond directly.`;

  // Message history for the ReAct loop
  const messages: Array<
    SystemMessage | HumanMessage | AIMessageClass | ToolMessage
  > = [new SystemMessage(CLARIFY_SYSTEM_PROMPT), new HumanMessage(userPrompt)];

  const newPosts: ChannelPost[] = [];
  let toolCallCount = 0;

  for (let iter = 0; iter < MAX_REACT_ITERATIONS; iter++) {
    const response = (await llmWithTools.invoke(messages)) as AIMessage;
    messages.push(
      new AIMessageClass({
        content:
          typeof response.content === "string"
            ? response.content
            : JSON.stringify(response.content),
        tool_calls: response.tool_calls,
      }),
    );

    // No tool calls → LLM is done
    if (!response.tool_calls || response.tool_calls.length === 0) {
      logger.info("Clarify: LLM finished without tool calls", {
        iteration: iter,
        alertId: input.alertId,
      });
      break;
    }

    // Execute each tool call
    for (const tc of response.tool_calls) {
      toolCallCount++;
      const foundTool = toolMap.get(tc.name);

      if (!foundTool) {
        logger.warn("Clarify: unknown tool requested", { tool: tc.name });
        messages.push(
          new ToolMessage({
            content: JSON.stringify({ error: `Unknown tool: ${tc.name}` }),
            tool_call_id: tc.id ?? `call_${toolCallCount}`,
          }),
        );
        continue;
      }

      try {
        logger.info("Clarify: calling tool", {
          tool: tc.name,
          args: tc.args,
          alertId: input.alertId,
        });

        const result = await (
          foundTool as { invoke(args: unknown): Promise<string> }
        ).invoke(tc.args);
        const resultStr =
          typeof result === "string" ? result : JSON.stringify(result);

        messages.push(
          new ToolMessage({
            content: resultStr,
            tool_call_id: tc.id ?? `call_${toolCallCount}`,
          }),
        );

        // If read_sources returned posts, store them for the session
        if (
          tc.name === "read_telegram_sources" &&
          resultStr.includes('"posts"')
        ) {
          try {
            const parsed = JSON.parse(resultStr);
            if (Array.isArray(parsed.posts)) {
              for (const p of parsed.posts) {
                const post: ChannelPost = {
                  channel: parsed.channel ?? tc.args.channel,
                  text: p.text ?? "",
                  ts: p.ts ?? Date.now(),
                  messageUrl: p.messageUrl,
                };
                newPosts.push(post);
                await pushSessionPost(post);
              }
            }
          } catch {
            // JSON parse failed — ignore
          }
        }
      } catch (err) {
        logger.warn("Clarify: tool execution failed", {
          tool: tc.name,
          error: String(err),
        });
        messages.push(
          new ToolMessage({
            content: JSON.stringify({
              error: `Tool execution failed: ${String(err)}`,
              retry: false,
            }),
            tool_call_id: tc.id ?? `call_${toolCallCount}`,
          }),
        );
      }
    }
  }

  // Parse the final LLM response for structured findings
  const lastMsg = messages[messages.length - 1];
  const lastContent =
    lastMsg && "content" in lastMsg && typeof lastMsg.content === "string"
      ? lastMsg.content
      : "";

  let clarified = false;
  let newExtractions: ValidatedExtraction[] = [];

  try {
    const cleaned = lastContent
      .replace(/^```(?:json)?\s*\n?/i, "")
      .replace(/\n?```\s*$/i, "");
    const findings = JSON.parse(cleaned.trim());
    clarified = findings.clarified === true;

    // Convert new_data into a synthetic validated extraction
    if (findings.new_data && clarified) {
      const syntheticExtraction: ValidatedExtraction = {
        channel: "mcp_clarify",
        region_relevance: 1.0,
        source_trust: 0.85,
        tone: "calm" as const,
        time_relevance: 1.0,
        country_origin: findings.new_data.country_origin ?? null,
        rocket_count: findings.new_data.rocket_count ?? null,
        is_cassette: findings.new_data.is_cassette ?? null,
        intercepted: findings.new_data.intercepted ?? null,
        intercepted_qual: null,
        intercepted_qual_num: null,
        sea_impact: null,
        sea_impact_qual: null,
        sea_impact_qual_num: null,
        open_area_impact: null,
        open_area_impact_qual: null,
        open_area_impact_qual_num: null,
        hits_confirmed: findings.new_data.hits_confirmed ?? null,
        casualties: findings.new_data.casualties ?? null,
        injuries: findings.new_data.injuries ?? null,
        eta_refined_minutes: null,
        confidence: Math.min(
          0.9,
          (input.votedResult.confidence ?? 0.5) +
            (findings.confidence_boost ?? 0.15),
        ),
        valid: true,
        messageUrl: undefined,
      };
      newExtractions = [syntheticExtraction];
    }
  } catch {
    logger.info("Clarify: could not parse final LLM response as JSON", {
      alertId: input.alertId,
    });
  }

  logger.info("Clarify: completed", {
    alertId: input.alertId,
    toolCallCount,
    clarified,
    newPosts: newPosts.length,
    newExtractions: newExtractions.length,
  });

  return { newPosts, newExtractions, toolCallCount, clarified };
}
