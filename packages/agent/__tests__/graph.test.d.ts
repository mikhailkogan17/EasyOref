/**
 * Tests for enrichment pipeline functions.
 *
 * Split into two parts:
 *   1. Unit tests — no LLM, no network. Test pure functions from extract, vote, message, helpers.
 *   2. Integration tests — call real OpenRouter API (skipped without OPENROUTER_API_KEY).
 *
 * Run only unit tests:  vitest run packages/bot/src/__tests__/graph.test.ts
 * Run with integration:  OPENROUTER_API_KEY=sk-... vitest run packages/bot/src/__tests__/graph.test.ts
 */
export {};
//# sourceMappingURL=graph.test.d.ts.map