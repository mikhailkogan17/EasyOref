import type { QaState } from "../qa-graph.js";

export type QaIntent =
  | "current_alert"
  | "recent_history"
  | "general_security"
  | "bot_help"
  | "off_topic";

/**
 * Patterns that indicate the question IS about alerts / attacks / security.
 * If none match, it's off_topic → polite rejection.
 */
const SECURITY_PATTERNS =
  /alert|alarm|siren|rocket|missile|intercep|iron\s*dome|shelter|attack|bomb|terror|drone|explosi|casualt|injur|hit|strike|launch|warning|threat|safe|danger|mortar|shrapnel|cluster|fragment|mada|ambulance|damage|impact|origin|iran|lebanon|hezbollah|hamas|houthi|gaza|yemen|syria|idf|pikud|oref|haOref|history|yesterday|happened|last\s*week|past|צבע אדום|אזעק|מתקפ|טיל|רקט|יירוט|כיפת ברזל|מקלט|פגיע|שיגור|פיצוץ|התרע|נפגע|אירוע|פיקוד|העורף|חמאס|חיזבאלה|איראן|לבנון|תימן|חות'י|סירנ|אתמול|שבוע|ракет|тревог|сирен|атак|обстрел|перехват|попадани|убежищ|укрыти|осколк|кассетн|пострадав|удар|взрыв|дрон|боеголов|запуск|угроз|предупрежд|безопасн|прилёт|прилет|хамас|хизбалла|хезболла|иран|ливан|йемен|хуситы|хуси|ЦАХАЛ|пикуд|ореф|азак|мада|скорая|железный купол|попадан|вчера|прошл|истори|было|произош/i;

const INTENT_PATTERNS: Record<string, RegExp> = {
  current_alert:
    /current|now|сейчас|сегодня|last|recent|latest|последн|today|когда|сколько|какие|были\s*ли|עכשיו|היום|האחרונה|קורה|الآن|اليوم/i,
  recent_history:
    /history|yesterday|last\s*week|past|אתמול|שבוע|вчера|прошл|история|أمس/i,
  bot_help: /^(help|start|\/start|עזרה|помощь|مساعدة)$/i,
};

function classifyIntent(message: string): QaIntent {
  // First: check if it's about security at all
  if (INTENT_PATTERNS.bot_help.test(message.trim())) return "bot_help";

  if (!SECURITY_PATTERNS.test(message)) return "off_topic";

  // Within security domain, sub-classify
  if (INTENT_PATTERNS.current_alert.test(message)) return "current_alert";
  if (INTENT_PATTERNS.recent_history.test(message)) return "recent_history";

  return "general_security";
}

export async function intentNode(state: QaState): Promise<Partial<QaState>> {
  const intent = classifyIntent(state.userMessage);
  return { intent };
}
