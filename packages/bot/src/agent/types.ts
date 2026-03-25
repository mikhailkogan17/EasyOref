/** Re-export types from shared and agent packages */
export type {
  ActiveSession,
  AlertMeta,
  AlertType,
  AlertTypeConfig,
  ChannelPost,
  ChannelTracking,
  NewsChannelWithUpdates,
  NewsMessage,
  CitedSource,
  ClarifyInput,
  ClarifyOutput,
  EnrichmentData,
  ExtractContext,
  ExtractionResult,
  GifMode,
  InlineCite,
  QualitativeCount,
  RelevanceCheck,
  RunEnrichmentInput,
  TelegramMessage,
  ValidatedExtraction,
  VotedResult,
} from "@easyoref/shared";

export type { AgentStateType } from "@easyoref/agent";
export { AgentState } from "@easyoref/agent";

import { createEmptyEnrichmentData } from "@easyoref/shared";
export const emptyEnrichmentData = createEmptyEnrichmentData;
