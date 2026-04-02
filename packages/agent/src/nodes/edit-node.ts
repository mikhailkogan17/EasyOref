/**
 * Edit Node — build enriched message text and send Telegram edit.
 *
 * Receives state.previousEnrichment (built by synthesize-node) and
 * state.currentText, renders the enriched message, and edits the
 * Telegram message via Bot API.
 *
 * Re-exports legacy helpers for backwards-compat.
 */

import * as logger from "@easyoref/monitoring";
import type { AlertType, SynthesizedInsightType, VotedResultType } from "@easyoref/shared";
import {
  config,
  getActiveSession,
  setActiveSession,
  textHash,
  getLanguagePack,
} from "@easyoref/shared";
import { AIMessage } from "langchain";
import { Bot } from "grammy";
import type { AgentStateType } from "../graph.js";
import {
  buildCitationMap,
  buildEnrichedMessage,
  formatCitations,
  insertBeforeBlockEnd,
} from "../utils/message.js";

// Re-exports for backwards-compat
export {
  insertBeforeBlockEnd,
  buildEnrichedMessage,
};

/** @deprecated Use insertBeforeBlockEnd */
export const insertBeforeTimeLine = insertBeforeBlockEnd;

// ── Inline citation helper (legacy) ───────────────────

/** Format inline citations: [[1]](url) */
export function inlineCites(
  indices: number[],
  citedSources: Array<{ index: number; messageUrl: string }>,
): string {
  const parts: string[] = [];
  for (const idx of indices) {
    const src = citedSources.find((s) => s.index === idx);
    if (src?.messageUrl) {
      parts.push(`<a href="${src.messageUrl}">[${idx}]</a>`);
    }
  }
  return parts.length > 0 ? " " + parts.join(", ") : "";
}

// ── Types ──────────────────────────────────────────────

export interface TelegramTargetMessage {
  chatId: string;
  messageId: number;
  isCaption: boolean;
}

export interface EditMessageInput {
  alertId: string;
  alertTs: number;
  alertType: AlertType;
  chatId: string;
  messageId: number;
  isCaption: boolean;
  telegramMessages?: TelegramTargetMessage[];
  currentText: string;
  votedResult: VotedResultType | undefined;
  synthesizedInsights: SynthesizedInsightType[];
}

// ── Telegram edit ──────────────────────────────────────

/**
 * Edit the Telegram message with enriched data.
 * Uses state.synthesizedInsights (built by synthesize-node).
 */
export const editTelegramMessage = async (
  input: EditMessageInput,
): Promise<void> => {
  if (!config.botToken) return;

  const tgBot = new Bot(config.botToken);
  const insights = input.synthesizedInsights ?? [];

  const targets: TelegramTargetMessage[] = input.telegramMessages ?? [
    {
      chatId: input.chatId,
      messageId: input.messageId,
      isCaption: input.isCaption,
    },
  ];

  // Skip if nothing useful to show yet
  const hasContent = insights.some((i) =>
    ["origin", "intercepted", "hits", "rocket_count"].includes(i.key),
  );
  if (!hasContent) {
    logger.info("edit-node: skipping edit — no actionable content", {
      insightKeys: insights.map((i) => i.key),
    });
    return;
  }

  const newText = buildEnrichedMessage(
    input.currentText,
    input.alertType,
    input.alertTs,
    insights,
  );

  // Dedup: skip if text hasn't changed
  const hash = textHash(newText);
  // Use a simple in-memory guard — we no longer persist enrichment to Redis
  // TODO: persist hash to session if needed for dedup across graph runs

  for (const t of targets) {
    try {
      if (t.isCaption) {
        await tgBot.api.editMessageCaption(t.chatId, t.messageId, {
          caption: newText,
          parse_mode: "HTML",
        });
      } else {
        await tgBot.api.editMessageText(t.chatId, t.messageId, newText, {
          parse_mode: "HTML",
        });
      }
    } catch (err) {
      const errStr = String(err);
      if (!errStr.includes("message is not modified")) {
        throw err;
      }
    }
  }

  void hash; // referenced above for future dedup use

  // Keep session.currentText in sync for monitoring removal
  const sess = await getActiveSession();
  if (sess) {
    sess.currentText = newText;
    await setActiveSession(sess);
  }
};

// ── Silent meta reply ──────────────────────────────────

/**
 * Send a single silent reply with key intel after early_warning.
 * Sent strictly once per session thread (guarded by session.metaMessageSent).
 * Only fires when:
 *  - alertType === "early_warning"
 *  - synthesizedInsights has at least rocket_count OR eta_absolute
 *  - session.metaMessageSent !== true
 */
export const sendMetaReply = async (
  alertType: AlertType,
  synthesizedInsights: SynthesizedInsightType[],
  targets: TelegramTargetMessage[],
): Promise<void> => {
  if (alertType !== "early_warning") return;
  if (!config.botToken) return;

  const get = (key: string) =>
    synthesizedInsights.find((i) => i.key === key);

  const rocketCount = get("rocket_count")?.value;
  const etaAbsolute = get("eta_absolute")?.value;
  const origin = get("origin")?.value;

  // Need at least rocket_count or eta_absolute to send a useful meta reply
  if (!rocketCount && !etaAbsolute) return;

  const sess = await getActiveSession();
  if (!sess) return;
  if (sess.metaMessageSent) return;

  const langPack = getLanguagePack(config.language);
  const labels = langPack.labels;

  const isCassette = get("is_cassette")?.value === "true";

  // Build citation map for consistent link numbering
  const citationMap = buildCitationMap(synthesizedInsights);

  // Build text lines dynamically — only include fields that exist
  const lines: string[] = [];

  if (rocketCount) {
    const originPart = origin ? ` (${origin})` : "";
    const cassettePart = isCassette ? labels.metaCassette : "";
    const rocketInsight = get("rocket_count")!;
    const cites = formatCitations(rocketInsight.sourceUrls, citationMap);
    lines.push(`${labels.metaRockets}${originPart}: ${rocketCount}${cassettePart}${cites}`);
  } else if (origin) {
    const originInsight = get("origin")!;
    const cites = formatCitations(originInsight.sourceUrls, citationMap);
    lines.push(`${labels.metaOrigin}: ${origin}${cites}`);
  }

  if (etaAbsolute) {
    const etaInsight = get("eta_absolute")!;
    const cites = formatCitations(etaInsight.sourceUrls, citationMap);
    lines.push(`${labels.metaArrival}: ${etaAbsolute}${cites}`);
  }

  if (lines.length === 0) return;
  const text = lines.join("\n");

  const tgBot = new Bot(config.botToken);

  for (const t of targets) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sendOpts: any = {
        reply_to_message_id: t.messageId,
        allow_sending_without_reply: true,
        disable_notification: true,
        parse_mode: "HTML",
      };
      await tgBot.api.sendMessage(t.chatId, text, sendOpts);
    } catch (err) {
      // Best-effort: only rethrow unexpected errors
      const errStr = String(err);
      if (!errStr.includes("message to be replied not found")) {
        throw err;
      }
    }
  }

  // Mark sent — persist to session
  sess.metaMessageSent = true;
  await setActiveSession(sess);
};

// ── Node ───────────────────────────────────────────────

export const editNode = async (
  state: AgentStateType,
): Promise<Partial<AgentStateType>> => {
  const synthesized = state.synthesizedInsights ?? [];

  // Per spec: early_warning messages are NOT edited with enrichment inline.
  // Only the meta reply (sendMetaReply) provides metadata for early_warning.
  if (state.alertType !== "early_warning") {
    await editTelegramMessage({
      alertId: state.alertId,
      alertTs: state.alertTs,
      alertType: state.alertType,
      chatId: state.chatId,
      messageId: state.messageId,
      isCaption: state.isCaption,
      telegramMessages: state.telegramMessages,
      currentText: state.currentText,
      votedResult: state.votedResult,
      synthesizedInsights: synthesized,
    });
  }

  const targets = state.telegramMessages ?? [
    { chatId: state.chatId, messageId: state.messageId, isCaption: state.isCaption },
  ];
  await sendMetaReply(state.alertType, synthesized, targets);

  return {
    messages: [
      new AIMessage(
        JSON.stringify({
          node: "edit",
          synthesizedKeys: synthesized.map((i) => i.key),
          targets: (state.telegramMessages ?? [{ chatId: state.chatId }]).length,
        }),
      ),
    ],
  };
};
