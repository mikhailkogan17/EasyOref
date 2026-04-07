/**
 * Edit Node — build enriched message text and send Telegram edit.
 *
 * Receives state.synthesizedInsights (built by synthesize-node) and
 * state.currentText, renders the enriched message, and edits the
 * Telegram message via Bot API.
 */

import type {
  AlertType,
  Language,
  SynthesizedInsightType,
  VotedResultType,
} from "@easyoref/shared";
import {
  config,
  getActiveSession,
  getLanguagePack,
  setActiveSession,
} from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import { Bot } from "grammy";
import { AIMessage } from "langchain";
import {
  buildEnrichedMessage,
  formatCitations,
} from "../../../utils/message.js";
import type { AgentStateType } from "../enrichment-graph.js";

export const CANARY_ALERT_PREFIX = "canary-";

// ── Types ──────────────────────────────────────────────

export interface TelegramTargetMessage {
  chatId: string;
  messageId: number;
  isCaption: boolean;
  /** BCP-47 language tag for the target user. Used to pick the right localized value. */
  language?: string;
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
  // Skip Telegram API for canary (synthetic test) alerts
  if (input.alertId.startsWith(CANARY_ALERT_PREFIX)) {
    logger.info("edit-node: canary alert — skipping Telegram edit", {
      alertId: input.alertId,
    });
    return;
  }

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

  for (const t of targets) {
    const newText = buildEnrichedMessage(
      input.currentText,
      input.alertType,
      input.alertTs,
      insights,
      t.language as Language | undefined,
    );

    try {
      if (t.isCaption) {
        await tgBot.api.editMessageCaption(t.chatId, t.messageId, {
          caption: newText,
          parse_mode: "HTML",
        });
      } else {
        await tgBot.api.editMessageText(t.chatId, t.messageId, newText, {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        });
      }
    } catch (err) {
      const errStr = String(err);
      if (!errStr.includes("message is not modified")) {
        throw err;
      }
    }
  }

  // Keep session.currentText in sync using English as canonical text for monitoring
  const canonicalText = buildEnrichedMessage(
    input.currentText,
    input.alertType,
    input.alertTs,
    insights,
    "en",
  );
  const sess = await getActiveSession();
  if (sess) {
    sess.currentText = canonicalText;
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

  const get = (key: string) => synthesizedInsights.find((i) => i.key === key);

  // Global guard: need rocket_count or eta_absolute in English (canonical)
  const hasRocket = !!get("rocket_count")?.value.en;
  const hasEta = !!get("eta_absolute")?.value.en;
  if (!hasRocket && !hasEta) return;

  const sess = await getActiveSession();
  if (!sess) return;
  if (sess.metaMessageSent) return;

  const isClusterMunition = get("is_cluster_munition")?.value.en === "true";

  const tgBot = new Bot(config.botToken);

  for (const t of targets) {
    const lang = (t.language ?? "ru") as Language;
    const labels = getLanguagePack(lang).labels;

    const rocketCount = get("rocket_count")?.value[lang];
    const etaAbsolute = get("eta_absolute")?.value[lang];
    const origin = get("origin")?.value[lang];

    // Build text lines for this target's language
    const lines: string[] = [];

    if (rocketCount) {
      const originPart = origin ? ` (${origin})` : "";
      const clusterMunitionPart = isClusterMunition
        ? labels.metaClusterMunition
        : "";
      const rocketInsight = get("rocket_count")!;
      const cites = formatCitations(rocketInsight.sourceUrls);
      lines.push(
        `${labels.metaRockets}${originPart}: ${rocketCount}${clusterMunitionPart}${cites}`,
      );
    } else if (origin) {
      const originInsight = get("origin")!;
      const cites = formatCitations(originInsight.sourceUrls);
      lines.push(`${labels.metaOrigin}: ${origin}${cites}`);
    }

    if (etaAbsolute) {
      const etaInsight = get("eta_absolute")!;
      const cites = formatCitations(etaInsight.sourceUrls);
      lines.push(`${labels.metaArrival}: ${etaAbsolute}${cites}`);
    }

    if (lines.length === 0) continue;
    const text = lines.join("\n");

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sendOpts: any = {
        reply_to_message_id: t.messageId,
        allow_sending_without_reply: true,
        disable_notification: true,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
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
    {
      chatId: state.chatId,
      messageId: state.messageId,
      isCaption: state.isCaption,
    },
  ];
  await sendMetaReply(state.alertType, synthesized, targets);

  return {
    messages: [
      new AIMessage(
        JSON.stringify({
          node: "edit",
          synthesizedKeys: synthesized.map((i) => i.key),
          targets: (state.telegramMessages ?? [{ chatId: state.chatId }])
            .length,
        }),
      ),
    ],
  };
};
