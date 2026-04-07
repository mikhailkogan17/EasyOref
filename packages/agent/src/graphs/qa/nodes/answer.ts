import { config } from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import { ToolMessage } from "@langchain/core/messages";
import { ChatOpenRouter } from "@langchain/openrouter";
import { createGetLastAttackTool } from "../../../utils/query-history.js";
import { createSearchNewsTool } from "../../../utils/search-news.js";
import type { QaState } from "../qa-graph.js";

const answerSystemPrompt = `You are EasyOref, a Telegram bot assistant for Israeli security alerts (Pikud HaOref / Home Front Command).

Your task: answer the user's question about rocket attacks using the provided tools.

TOOLS (call in order):
1. get_last_attack() — ALWAYS call first. Returns the last attack in the user's area: zone, area, macro region, early_warning time, siren times, resolved time. Also tells if there's an active attack right now.
2. search_channel_news(from_time, to_time) — call AFTER get_last_attack. Search monitored Telegram news channels in a time window. Use: from = early_time (or first siren - 10min), to = resolved_time + 10min (or last siren + 15min if no resolved).

WORKFLOW:
1. Call get_last_attack() to get attack timeline
2. Call search_channel_news() with the attack time window to get enrichment details
3. Combine both to give a detailed answer about the last attack

ANSWER FORMAT:
- If active_attack=true: report current attack with all available details
- If last_attack exists: report detailed analysis — zone, times, and any details from news (rocket count, type, origin, interceptions, casualties, impacts)
- If history is truncated (3000 cap): mention "data available from HH:MM only" if relevant
- If no attack found: say clearly "no attacks recorded today in your area"

RULES:
1. Answer in the user's language (ru/en/he/ar).
2. Use ONLY tool results and context. Never fabricate data.
3. Include source citations inline as [[channel_name]](url) when URLs are available in news posts.
4. Format times as HH:MM.
5. Be concise but thorough. Include: attack timeline, area, rocket count/type, origin, interceptions, casualties if mentioned in news.
6. Use emojis sparingly: 🚨 for sirens, ⚠️ for warnings, ✅ for resolved, 🚀 for rockets.
7. Keep the answer under 600 characters.`;

export async function answerNode(state: QaState): Promise<Partial<QaState>> {
  // bot_help and off_topic are handled in context node — pass through
  if (state.intent === "bot_help" || state.intent === "off_topic") {
    return { answer: state.answer || state.context, sources: [] };
  }

  // Create tools with pre-fetched data from context node
  const attackTool = createGetLastAttackTool(state.history ?? []);
  const newsTool = createSearchNewsTool(state.posts ?? []);

  const model = new ChatOpenRouter({
    apiKey: config.agent.apiKey,
    model: config.agent.qaModel,
    temperature: 0,
    maxTokens: 1024,
  });

  const tools = [attackTool, newsTool];
  const modelWithTools = model.bindTools(tools);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolMap: Map<string, any> = new Map(tools.map((t) => [t.name, t]));

  const systemMsg = {
    role: "system" as const,
    content: `${answerSystemPrompt}\nUser language: ${state.language ?? "ru"}`,
  };
  const userMsg = {
    role: "user" as const,
    content: `Context:\n${state.context}\n\nQuestion: ${state.userMessage}`,
  };

  try {
    // Tool-calling loop (max 4 rounds: get_last_attack → search_news → maybe refine)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgs: any[] = [systemMsg, userMsg];

    for (let round = 0; round < 4; round++) {
      const response = await modelWithTools.invoke(msgs, {
        signal: AbortSignal.timeout(30_000),
      });
      msgs.push(response);

      if (!response.tool_calls?.length) break;

      for (const tc of response.tool_calls) {
        const toolFn = toolMap.get(tc.name);
        if (!toolFn) {
          msgs.push(
            new ToolMessage({
              content: JSON.stringify({ error: `Unknown tool: ${tc.name}` }),
              tool_call_id: tc.id!,
            }),
          );
          continue;
        }
        const result = await toolFn.invoke(tc.args);
        msgs.push(new ToolMessage({ content: result, tool_call_id: tc.id! }));
      }
    }

    // Last message is the final AI response (no pending tool calls)
    const lastMsg = msgs[msgs.length - 1];
    const text =
      typeof lastMsg.content === "string"
        ? lastMsg.content
        : JSON.stringify(lastMsg.content);

    return { answer: text, sources: [] };
  } catch (err) {
    logger.error("answerNode: failed", { error: String(err) });

    const errMsg: Record<string, string> = {
      ru: "Не удалось обработать вопрос. Попробуйте ещё раз.",
      en: "Could not process your question. Please try again.",
      he: "לא הצלחתי לעבד את השאלה. נסה שוב.",
      ar: "لم أتمكن من معالجة سؤالك. حاول مرة أخرى.",
    };
    const lang = (state.language ?? "ru") as keyof typeof errMsg;
    return { answer: errMsg[lang] ?? errMsg.ru, sources: [] };
  }
}
