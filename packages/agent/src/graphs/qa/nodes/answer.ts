import { config, fetchOrefHistory } from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import { ToolMessage } from "@langchain/core/messages";
import { ChatOpenRouter } from "@langchain/openrouter";
import { createQueryHistoryTool } from "../../../utils/query-history.js";
import type { QaState } from "../qa-graph.js";

const answerSystemPrompt = `You are EasyOref, a Telegram bot assistant for Israeli security alerts (Pikud HaOref / Home Front Command).

Your task: answer the user's question based on the provided context and by calling the query_alert_history tool when needed. Never fabricate data.

TOOL: query_alert_history(zone_id, category)
- ALWAYS call this tool when asked about siren counts, alert times, or resolved events.
- zone_id=0: user's area (all configured zones aggregated). Prefer this unless a specific zone is requested.
- category=1: rocket/missile sirens. category=13: incident resolved. category=0: all types.
- Use zone_id from CONFIGURED_ZONES when a specific area is requested.

RULES:
1. Answer in the user's language (ru/en/he/ar).
2. For questions about "how many sirens", "when were the sirens", "what time" — call query_alert_history first.
3. Use ONLY tool results and context data. If data is missing, say so clearly.
4. Include source citations inline as [[channel_name]](url) when source URLs are available.
5. Format times as HH:MM (Israel time, already in tool results).
6. Be concise. Include: alert times, areas, rocket count/type, origin, interceptions, casualties if known.
7. Use emojis sparingly: 🚨 for sirens, ⚠️ for warnings, ✅ for resolved, 🚀 for rockets.
8. Keep the answer under 500 characters.`;

export async function answerNode(state: QaState): Promise<Partial<QaState>> {
  // bot_help and off_topic are handled in context node — pass through
  if (state.intent === "bot_help" || state.intent === "off_topic") {
    return { answer: state.answer || state.context, sources: [] };
  }

  // Pre-fetch history once — tool closure binds to this data
  const history = await fetchOrefHistory().catch(() => []);
  const queryTool = createQueryHistoryTool(history);

  const model = new ChatOpenRouter({
    apiKey: config.agent.apiKey,
    model: config.agent.qaModel,
    temperature: 0,
    maxTokens: 1024,
  });

  const modelWithTools = model.bindTools([queryTool]);

  const systemMsg = {
    role: "system" as const,
    content: `${answerSystemPrompt}\nUser language: ${state.language ?? "ru"}`,
  };
  const userMsg = {
    role: "user" as const,
    content: `Context:\n${state.context}\n\nQuestion: ${state.userMessage}`,
  };

  try {
    // Tool-calling loop (max 4 rounds to allow multiple zone queries)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgs: any[] = [systemMsg, userMsg];

    for (let round = 0; round < 4; round++) {
      const response = await modelWithTools.invoke(msgs, {
        signal: AbortSignal.timeout(30_000),
      });
      msgs.push(response);

      if (!response.tool_calls?.length) break;

      for (const tc of response.tool_calls) {
        const result = await queryTool.invoke(
          tc.args as { zone_id: number; category: number },
        );
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

