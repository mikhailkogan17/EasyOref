import type { ChannelPostType } from "@easyoref/shared";
import { config } from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import { ToolMessage } from "@langchain/core/messages";
import { ChatOpenRouter } from "@langchain/openrouter";
import { createSearchNewsTool } from "../../../utils/search-news.js";
import type { QaState } from "../qa-graph.js";

const answerSystemPrompt = `You are EasyOref, a Telegram bot assistant for Israeli security alerts (Pikud HaOref / Home Front Command).

You are given context about current alerts, attack history (last 24h), and enrichment data.
You also have a tool to search monitored Telegram news channels for details.

CONTEXT SECTIONS (already provided):
- ACTIVE SESSION: current ongoing attack being tracked by the bot
- CURRENT ACTIVE ALERTS: live alerts from official Oref API right now
- ATTACK HISTORY: all attack waves in the last 24h. Waves marked with 🚨 hit the user's area.
- ENRICHMENT DATA: AI-extracted details from news (rocket count, origin, ETA, interceptions)

TOOL:
- search_channel_news(from_time, to_time): search news channels in a time window (HH:MM format).
  ALWAYS call this tool when there are attacks in the history! Use the attack timestamps to set the window:
  from_time = attack time - 10 min, to_time = attack time + 15 min.
  If multiple attacks, use the EARLIEST - 10 min to LATEST + 15 min.

WORKFLOW:
1. Read the context (attacks, active alerts, enrichment)
2. If there are attacks in the history → call search_channel_news with appropriate time window
3. Combine context + news to give a detailed answer

RULES:
1. Answer in the user's language (ru/en/he/ar).
2. Use ONLY the provided context and tool results. NEVER fabricate data, times, or rocket counts.
3. When citing news, use [[channel_name]](url) format (clickable Telegram link).
4. Format times as HH:MM.
5. Be concise but thorough. Include: attack timeline, area, rocket count/type, origin, interceptions, casualties if available.
6. Use emojis sparingly: 🚨 for sirens, ✅ for resolved, 🚀 for rockets.
7. Keep the answer under 800 characters.
8. If attack history shows attacks in user's area — describe them with all available details from context + news.
9. If no attacks hit user's area — say so clearly, but mention the general situation if attacks happened elsewhere.
10. If history service was unavailable — tell the user honestly.`;

export async function answerNode(state: QaState): Promise<Partial<QaState>> {
  // bot_help and off_topic are handled in context node — pass through
  if (state.intent === "bot_help" || state.intent === "off_topic") {
    return { answer: state.answer || state.context, sources: [] };
  }

  const newsTool = createSearchNewsTool(
    (state.posts ?? []) as ChannelPostType[],
  );

  const model = new ChatOpenRouter({
    apiKey: config.agent.apiKey,
    model: config.agent.qaModel,
    temperature: 0,
    maxTokens: 1024,
  });

  const tools = [newsTool];
  const modelWithTools = model.bindTools(tools);

  const systemMsg = {
    role: "system" as const,
    content: `${answerSystemPrompt}\nUser language: ${state.language ?? "ru"}`,
  };
  const userMsg = {
    role: "user" as const,
    content: `Context:\n${state.context}\n\nQuestion: ${state.userMessage}`,
  };

  try {
    // Tool-calling loop (max 3 rounds)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgs: any[] = [systemMsg, userMsg];

    for (let round = 0; round < 3; round++) {
      const response = await modelWithTools.invoke(msgs, {
        signal: AbortSignal.timeout(30_000),
      });
      msgs.push(response);

      if (!response.tool_calls?.length) break;

      for (const tc of response.tool_calls) {
        if (tc.name !== "search_channel_news") {
          msgs.push(
            new ToolMessage({
              content: JSON.stringify({ error: `Unknown tool: ${tc.name}` }),
              tool_call_id: tc.id!,
            }),
          );
          continue;
        }
        const result = await newsTool.invoke(
          tc.args as { from_time: string; to_time: string },
        );
        msgs.push(
          new ToolMessage({
            content:
              typeof result === "string" ? result : JSON.stringify(result),
            tool_call_id: tc.id!,
          }),
        );
      }
    }

    // Last message is the final AI response
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
