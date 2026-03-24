/**
 * Integration tests for the enrichment pipeline.
 *
 * Two modes:
 *   - Deterministic tests (always run): post-filter, vote, message building
 *   - LLM tests (need OPENROUTER_API_KEY): real extraction via OpenRouter
 *
 * Run with real API:
 *   OPENROUTER_API_KEY=sk-or-... npx vitest run enrichment.integration
 *
 * The API key is read from config.yaml automatically if present.
 */
export {};
//# sourceMappingURL=enrichment.integration.test.d.ts.map