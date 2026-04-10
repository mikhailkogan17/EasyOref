/**
 * Edit Node — send/update two enrichment reply messages.
 *
 * Message 1 (Launch Info): ETA, origin, rockets, cluster — all users.
 * Message 2 (Analysis):    intercepted, hits, casualties — pro only.
 *
 * Both messages are created on first insight and edited on subsequent runs.
 * Oref alert messages are NEVER edited.
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
  saveSynthesizedInsights,
  setActiveSession,
} from "@easyoref/shared";
import * as logger from "@easyoref/shared/logger";
import { Bot } from "grammy";
import { AIMessage } from "langchain";
import { formatCitations } from "../../../utils/message.js";
import type { AgentStateType } from "../enrichment-graph.js";

export const CANARY_ALERT_PREFIX = "canary-";

// ── Types ──────────────────────────────────────────────

export interface TelegramTargetMessage {
  chatId: string;
  messageId: number;
  isCaption: boolean;
  language?: string;
  baseText?: string;
  tier?: "free" | "pro";
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

// ── Insight categories ─────────────────────────────────

/** Launch info keys — Message 1 (free for all) */
const LAUNCH_KEYS = new Set([
  "eta_absolute",
  "origin",
  "rocket_count",
  "is_cluster_munition",
]);

/** Post-attack analysis keys — Message 2 (pro only) */
const ANALYSIS_KEYS = new Set([
  "intercepted",
  "hits",
  "casualties",
  "no_casualties",
]);

// ── Helpers ────────────────────────────────────────────

function buildLaunchLines(
  insights: SynthesizedInsightType[],
  lang: Language,
): string[] {
  const labels = getLanguagePack(lang).labels;
  const get = (key: string) => insights.find((i) => i.key === key);
  const lines: string[] = [];

  const etaVal = get("eta_absolute")?.value[lang];
  if (etaVal) {
    const cites = formatCitations(get("eta_absolute")!.sourceUrls);
    lines.push(`\u23F0 ${labels.metaArrival}: ${etaVal}${cites}`);
  }

  const origin = get("origin")?.value[lang];
  const rocketCount = get("rocket_count")?.value[lang];
  if (rocketCount) {
    const originPart = origin ? ` (${origin})` : "";
    const cites = formatCitations(get("rocket_count")!.sourceUrls);
    lines.push(
      `\u{1F680} ${labels.metaRockets}${originPart}: ${rocketCount}${cites}`,
    );
  } else if (origin) {
    const cites = formatCitations(get("origin")!.sourceUrls);
    lines.push(`\u{1F30D} ${labels.metaOrigin}: ${origin}${cites}`);
  }

  const clusterInsight = get("is_cluster_munition");
  if (clusterInsight) {
    const isCluster = clusterInsight.value.en === "true";
    const label = isCluster ? labels.metaClusterYes : labels.metaClusterNo;
    const cites = formatCitations(clusterInsight.sourceUrls);
    lines.push(`\u{1F4A3} ${labels.metaClusterMunition}: ${label}${cites}`);
  }

  return lines;
}

function buildAnalysisLines(
  insights: SynthesizedInsightType[],
  lang: Language,
): string[] {
  const labels = getLanguagePack(lang).labels;
  const get = (key: string) => insights.find((i) => i.key === key);
  const lines: string[] = [];

  const intercepted = get("intercepted")?.value[lang];
  if (intercepted) {
    const cites = formatCitations(get("intercepted")!.sourceUrls);
    lines.push(`\u{1F6E1} ${labels.metaIntercepted}: ${intercepted}${cites}`);
  }

  const hits = get("hits")?.value[lang];
  if (hits) {
    const cites = formatCitations(get("hits")!.sourceUrls);
    lines.push(`\u{1F4A5} ${labels.metaHits}: ${hits}${cites}`);
  }

  const casualties = get("casualties")?.value[lang];
  const noCasualties = get("no_casualties")?.value[lang];
  if (casualties) {
    const cites = formatCitations(get("casualties")!.sourceUrls);
    lines.push(`\u{1F3E5} ${labels.metaCasualties}: ${casualties}${cites}`);
  } else if (noCasualties) {
    const val =
      noCasualties === "none"
        ? labels.metaNoVictimsNone
        : labels.metaNoVictimsUnreported;
    const cites = formatCitations(get("no_casualties")!.sourceUrls);
    lines.push(`\u{1F3E5} ${labels.metaCasualties}: ${val}${cites}`);
  }

  return lines;
}

// ── Send or Update enrichment message ──────────────────

/**
 * Send a new reply or edit an existing enrichment message.
 * Returns sent message ID (new or existing).
 */
async function sendOrEdit(
  bot: InstanceType<typeof Bot>,
  chatId: string,
  replyToMessageId: number,
  existingMessageId: number | undefined,
  text: string,
): Promise<number> {
  if (existingMessageId) {
    try {
      await bot.api.editMessageText(chatId, existingMessageId, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      if (!String(err).includes("message is not modified")) throw err;
    }
    return existingMessageId;
  }

  const msg = await bot.api.sendMessage(chatId, text, {
    reply_parameters: {
      message_id: replyToMessageId,
      allow_sending_without_reply: true,
    },
    disable_notification: true,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  return msg.message_id;
}

// ── Main enrichment message functions ──────────────────

/**
 * Send/update launch info message (Message 1).
 * Contains: ETA, origin, rockets, cluster.
 * Sent to ALL targets (free + pro).
 */
export const sendOrUpdateLaunchInfo = async (
  synthesizedInsights: SynthesizedInsightType[],
  targets: TelegramTargetMessage[],
): Promise<void> => {
  if (!config.botToken) return;

  const launchInsights = synthesizedInsights.filter((i) =>
    LAUNCH_KEYS.has(i.key),
  );
  if (launchInsights.length === 0) return;

  const sess = await getActiveSession();
  if (!sess) return;

  const tgBot = new Bot(config.botToken);
  const ids: Record<string, number> = sess.launchMessageIds ?? {};

  for (const t of targets) {
    const lang = (t.language ?? "ru") as Language;
    const lines = buildLaunchLines(launchInsights, lang);
    if (lines.length === 0) continue;

    try {
      ids[t.chatId] = await sendOrEdit(
        tgBot,
        t.chatId,
        t.messageId,
        ids[t.chatId],
        lines.join("\n"),
      );
    } catch (err) {
      logger.warn("edit-node: launch message failed", {
        chatId: t.chatId,
        err: String(err),
      });
    }
  }

  sess.launchMessageIds = ids;
  await setActiveSession(sess);
};

/**
 * Send/update post-attack analysis message (Message 2).
 * Contains: intercepted, hits, casualties.
 * Sent only to PRO targets.
 */
export const sendOrUpdateAnalysis = async (
  synthesizedInsights: SynthesizedInsightType[],
  targets: TelegramTargetMessage[],
): Promise<void> => {
  if (!config.botToken) return;

  const analysisInsights = synthesizedInsights.filter((i) =>
    ANALYSIS_KEYS.has(i.key),
  );
  if (analysisInsights.length === 0) return;

  const proTargets = targets.filter((t) => t.tier !== "free");
  if (proTargets.length === 0) return;

  const sess = await getActiveSession();
  if (!sess) return;

  const tgBot = new Bot(config.botToken);
  const ids: Record<string, number> = sess.analysisMessageIds ?? {};

  for (const t of proTargets) {
    const lang = (t.language ?? "ru") as Language;
    const lines = buildAnalysisLines(analysisInsights, lang);
    if (lines.length === 0) continue;

    try {
      ids[t.chatId] = await sendOrEdit(
        tgBot,
        t.chatId,
        t.messageId,
        ids[t.chatId],
        lines.join("\n"),
      );
    } catch (err) {
      logger.warn("edit-node: analysis message failed", {
        chatId: t.chatId,
        err: String(err),
      });
    }
  }

  sess.analysisMessageIds = ids;
  await setActiveSession(sess);
};

// ── Node ───────────────────────────────────────────────

export const editNode = async (
  state: AgentStateType,
): Promise<Partial<AgentStateType>> => {
  const synthesized = state.synthesizedInsights ?? [];

  // Skip Telegram API for canary alerts
  if (state.alertId.startsWith(CANARY_ALERT_PREFIX)) {
    logger.info("edit-node: canary alert — skipping Telegram", {
      alertId: state.alertId,
    });
    return {
      messages: [
        new AIMessage(
          JSON.stringify({
            node: "edit",
            synthesizedKeys: synthesized.map((i) => i.key),
            targets: 0,
          }),
        ),
      ],
    };
  }

  const targets = state.telegramMessages ?? [
    {
      chatId: state.chatId,
      messageId: state.messageId,
      isCaption: state.isCaption,
    },
  ];

  // Message 1: launch info (ETA, origin, rockets, cluster) — all users
  await sendOrUpdateLaunchInfo(synthesized, targets);

  // Message 2: post-attack analysis (interceptions, hits, casualties) — pro only
  await sendOrUpdateAnalysis(synthesized, targets);

  // Persist synthesized insights for carry-forward to resolved phase
  if (synthesized.length > 0) {
    await saveSynthesizedInsights(synthesized);
  }

  return {
    messages: [
      new AIMessage(
        JSON.stringify({
          node: "edit",
          synthesizedKeys: synthesized.map((i) => i.key),
          targets: targets.length,
        }),
      ),
    ],
  };
};
