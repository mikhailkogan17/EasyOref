import { config } from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import { ChatOpenRouter } from "@langchain/openrouter";
import { z } from "zod";
import type { QaState } from "../qa-graph.js";

const OutputSchema = z.object({
  text: z
    .string()
    .describe("Answer in the user's language with inline source citations"),
  sources: z.array(z.string()).describe("Source URLs used in the answer"),
});

const answerAgentOpts = {
  systemPrompt: `You are EasyOref, a Telegram bot assistant for Israeli security alerts (Pikud HaOref / Home Front Command).

Your task: answer the user's question based ONLY on the provided context data. Never fabricate data.

RULES:
1. Answer in the user's language (ru/en/he/ar).
2. Use ONLY data from the context. If specific data is missing, say so clearly.
3. Include source citations inline as [[channel_name]](url) when source URLs are available.
   Extract channel name from t.me URLs: https://t.me/N12LIVE/123 → [[N12LIVE]](https://t.me/N12LIVE/123)
   For private channels (t.me/c/...): use [[src]](url)
4. Format times in HH:MM format (Israel time, already provided in context).
5. Be concise but complete. Include:
   - Alert time(s) and phase (early warning / siren / resolved)
   - Areas affected
   - Rocket count if known
   - Cluster munitions if mentioned
   - Interceptions if available
   - Origin (Iran/Lebanon/Yemen etc.) if known
   - Casualties / damage if reported
6. Use emojis sparingly: 🚨 for sirens, ⚠️ for warnings, ✅ for resolved, 🚀 for rockets.
7. Keep the answer under 500 characters.
8. If there are NO alerts and NO history data in context, say there are no recent alerts.`,
};

export async function answerNode(state: QaState): Promise<Partial<QaState>> {
  // bot_help and off_topic are handled in context node — pass through
  if (state.intent === "bot_help" || state.intent === "off_topic") {
    return { answer: state.answer || state.context, sources: [] };
  }

  const model = new ChatOpenRouter({
    apiKey: config.agent.apiKey,
    model: config.agent.qaModel,
    temperature: 0,
    maxTokens: 1024,
  });

  const messages = [
    {
      role: "system" as const,
      content: `${answerAgentOpts.systemPrompt}\nUser language: ${state.language ?? "ru"}`,
    },
    {
      role: "user" as const,
      content: `Context:\n${state.context}\n\nQuestion: ${state.userMessage}`,
    },
  ];

  try {
    const structured = model.withStructuredOutput(OutputSchema);
    const result = await structured.invoke(messages, {
      signal: AbortSignal.timeout(30_000),
    });
    return { answer: result.text, sources: result.sources };
  } catch (err) {
    logger.warn("answerNode: structured output failed, falling back", {
      error: String(err),
    });

    try {
      const raw = await model.invoke(messages, {
        signal: AbortSignal.timeout(30_000),
      });
      const text =
        typeof raw.content === "string"
          ? raw.content
          : JSON.stringify(raw.content);
      return { answer: text, sources: [] };
    } catch (fallbackErr) {
      logger.error("answerNode: fallback also failed", {
        error: String(fallbackErr),
      });

      const errMsg: Record<string, string> = {
        ru: "Не удалось обработать вопрос. Попробуйте ещё раз.",
        en: "Could not process your question. Please try again.",
        he: "לא הצלחתי לעבד את השאלה. נסה שוב.",
        ar: "لم أتمكن من معالجة سؤالك. حاول مرة أخرى.",
      };
      const lang = (state.language ?? "ru") as keyof typeof errMsg;
      return {
        answer: errMsg[lang] ?? errMsg.ru,
        sources: [],
      };
    }
  }
}
