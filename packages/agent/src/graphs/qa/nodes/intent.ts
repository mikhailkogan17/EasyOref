import type { QaState } from "../qa-graph.js";

export type QaIntent =
  | "current_alert"
  | "recent_history"
  | "general_security"
  | "bot_help";

const INTENT_PATTERNS: Record<string, RegExp> = {
  current_alert: /alert|מתקפה|צבע אדום|ракет|тревог/i,
  recent_history: /history|yesterday|אתמול|вчера|история/i,
  bot_help: /help|start|עזרה|помощь/i,
};

function classifyIntent(message: string): QaIntent {
  for (const [intent, pattern] of Object.entries(INTENT_PATTERNS)) {
    if (pattern.test(message)) return intent as QaIntent;
  }
  return "general_security";
}

export async function intentNode(state: QaState): Promise<Partial<QaState>> {
  const intent = classifyIntent(state.userMessage);
  return { intent };
}
