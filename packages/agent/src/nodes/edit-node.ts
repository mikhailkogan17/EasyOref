/**
 * Edit Node — build enriched message text and send Telegram edit.
 *
 * Receives state.previousEnrichment (built by synthesize-node) and
 * state.currentText, renders the enriched message, and edits the
 * Telegram message via Bot API.
 *
 * Re-exports legacy helpers for backwards-compat.
 */

import type { AlertType, SynthesizedInsightType, VotedResultType } from "@easyoref/shared";
import {
  config,
  getActiveSession,
  setActiveSession,
  textHash,
} from "@easyoref/shared";
import { AIMessage } from "langchain";
import { Bot } from "grammy";
import type { AgentStateType } from "../graph.js";
import {
  appendMonitoring,
  buildEnrichedMessage,
  insertBeforeBlockEnd,
  MONITORING_RE,
  stripMonitoring,
} from "../utils/message.js";

// Re-exports for backwards-compat
export {
  MONITORING_RE,
  stripMonitoring,
  appendMonitoring,
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
  monitoringLabel?: string;
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
  const insights = input.synthesizedInsights;

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
  if (!hasContent) return;

  const newText = buildEnrichedMessage(
    input.currentText,
    input.alertType,
    input.alertTs,
    insights,
    input.monitoringLabel,
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

// ── Node ───────────────────────────────────────────────

export const editNode = async (
  state: AgentStateType,
): Promise<Partial<AgentStateType>> => {
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
    synthesizedInsights: state.synthesizedInsights,
    monitoringLabel: state.monitoringLabel,
  });

  return {
    messages: [
      new AIMessage(
        JSON.stringify({
          node: "edit",
          synthesizedKeys: state.synthesizedInsights.map((i) => i.key),
          targets: (state.telegramMessages ?? [{ chatId: state.chatId }]).length,
        }),
      ),
    ],
  };
};
