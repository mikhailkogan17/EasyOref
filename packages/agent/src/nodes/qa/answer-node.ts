import { config } from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import { ChatOpenRouter } from "@langchain/openrouter";
import { z } from "zod";
import type { QaState } from "../../qa-graph.js";

const OutputSchema = z.object({
  text: z.string().describe("Answer in the user's language"),
  sources: z.array(z.string()).describe("Source URLs if any"),
});

const answerAgentOpts = {
  systemPrompt: `You are EasyOref, a helpful Telegram bot assistant specializing in Israeli security alerts and Home Front Command information.
Answer concisely in the user's language based on the provided context.
If you have no relevant data, say so honestly. Never fabricate alert data.
For bot_help intent: explain what EasyOref does and how to use it.
Keep answers under 300 characters.`,
};

export async function answerNode(state: QaState): Promise<Partial<QaState>> {
  if (state.intent === "bot_help") {
    return { answer: state.context, sources: [] };
  }

  const model = new ChatOpenRouter({
    apiKey: config.agent.apiKey,
    model: config.agent.qaModel,
    temperature: 0,
    maxTokens: 512,
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
    const result = await structured.invoke(messages);
    return { answer: result.text, sources: result.sources };
  } catch (err) {
    logger.warn("answerNode: structured output failed, falling back", {
      error: String(err),
    });

    try {
      const raw = await model.invoke(messages);
      const text =
        typeof raw.content === "string"
          ? raw.content
          : JSON.stringify(raw.content);
      return { answer: text, sources: [] };
    } catch (fallbackErr) {
      logger.error("answerNode: fallback also failed", {
        error: String(fallbackErr),
      });
      return {
        answer: "Could not process your question. Please try again.",
        sources: [],
      };
    }
  }
}
