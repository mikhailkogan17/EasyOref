/** Re-export types from shared and agent packages */
export type {
  ActiveSession,
  AlertMeta,
  AlertType,
  AlertTypeConfig,
  ChannelPost,
  ChannelTrackingType,
  Enrichment,
  GifMode,
  Insight,
  NewsChannelWithUpdatesType,
  NewsMessageType,
  QualitativeCountType,
  RelevanceCheckType,
  RunEnrichmentInput,
  TelegramMessage,
  ValidatedInsight,
  VotedResult,
} from "@easyoref/shared";

export { AgentState } from "@easyoref/agent";
export type { AgentStateType } from "@easyoref/agent";

import { createEmptyEnrichment } from "@easyoref/shared";
export const emptyEnrichment = createEmptyEnrichment;
