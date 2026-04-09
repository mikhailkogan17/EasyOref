---
name: write-regression-test
description: "Write regression tests for EasyOref bug fixes. Use when: fixing a bug and need a test to prevent regression. Covers enrichment pipeline nodes, Q&A graph nodes, bot handlers, shared utils. Knows vitest patterns, mocking conventions, integration test setup."
argument-hint: "Describe the bug being fixed and which file(s) changed"
---

# Write Regression Test

Create vitest regression tests for EasyOref bug fixes. Follows existing test conventions.

## When to Use

- After fixing a bug in the enrichment or Q&A pipeline
- After changing node logic, bot handlers, or shared utils
- When a postmortem identifies a new failure pattern that needs a test

## Test File Layout

```
packages/
├── agent/__tests__/
│   ├── edit-node.test.ts          # edit node: sendMetaReply, editTelegramMessage
│   ├── extract-node.test.ts       # extract node: extractFromChannel
│   ├── post-filter-node.test.ts   # post-filter node: verification
│   ├── pre-filter-node.test.ts    # pre-filter node: noise filter + tracking
│   ├── synthesize-node.test.ts    # synthesize node: consensus + LLM
│   ├── qa-graph.test.ts           # Q&A graph: intent, context, answer
│   ├── graph.test.ts              # shared helpers: message formatting, time utils
│   ├── guardrails.test.ts         # guardrails: field length, banned patterns
│   ├── snapshot.test.ts           # golden input/output snapshots
│   ├── contracts.test.ts          # cross-package Zod schema contracts
│   ├── schemas.test.ts            # schema validation tests
│   ├── config.test.ts             # config loading tests
│   └── enrichment.integration.test.ts  # real LLM tests (needs OPENROUTER_API_KEY)
├── bot/src/__tests__/
│   ├── bot.test.ts                # alert sending, session management, cooldown
│   └── tier.test.ts               # tier middleware tests
└── shared/__tests__/
    └── shelter.test.ts            # shelter search tests
```

## Procedure

### Step 1: Determine Test File

Map the changed source file to its test file:

| Source File | Test File | Type |
|---|---|---|
| `agent/src/graphs/enrichment/nodes/edit.ts` | `agent/__tests__/edit-node.test.ts` | Unit |
| `agent/src/graphs/enrichment/nodes/extract.ts` | `agent/__tests__/extract-node.test.ts` | Unit |
| `agent/src/graphs/enrichment/nodes/post-filter.ts` | `agent/__tests__/post-filter-node.test.ts` | Unit |
| `agent/src/graphs/enrichment/nodes/pre-filter.ts` | `agent/__tests__/pre-filter-node.test.ts` | Unit |
| `agent/src/graphs/enrichment/nodes/synthesize.ts` | `agent/__tests__/synthesize-node.test.ts` | Unit |
| `agent/src/graphs/qa/nodes/*` | `agent/__tests__/qa-graph.test.ts` | Unit |
| `agent/src/utils/message.ts` | `agent/__tests__/graph.test.ts` | Unit |
| `agent/src/utils/guardrails.ts` | `agent/__tests__/guardrails.test.ts` | Unit |
| `agent/src/utils/consensus.ts` | `agent/__tests__/synthesize-node.test.ts` | Unit |
| `agent/src/utils/noise-filter.ts` | `agent/__tests__/pre-filter-node.test.ts` | Unit |
| `agent/src/models.ts` | `agent/__tests__/enrichment.integration.test.ts` | Integration |
| `bot/src/bot.ts` | `bot/src/__tests__/bot.test.ts` | Unit |
| `bot/src/middleware/tier.ts` | `bot/src/__tests__/tier.test.ts` | Unit |
| `shared/src/store.ts` | `agent/__tests__/edit-node.test.ts` (or contracts) | Unit |
| `shared/src/schemas.ts` | `agent/__tests__/schemas.test.ts` | Unit |

### Step 2: Read Existing Test File

ALWAYS read the **entire existing test file** before writing. Understand:
1. Which mocks are already set up (`vi.hoisted`, `vi.mock`)
2. The `describe`/`it` nesting structure
3. Naming conventions (e.g., `"should fire sendMetaReply on origin-only"`)
4. How the function under test is imported and called

### Step 3: Write the Regression Test

Follow these conventions EXACTLY:

**Imports:** Use `import { describe, it, expect, vi, beforeEach } from "vitest";`

**Test naming:** `it("should <expected_behavior> when <condition>")` or `it("<bugfix_description>")`

**Mock pattern (vi.hoisted):**
```typescript
const { mockFn } = vi.hoisted(() => ({
  mockFn: vi.fn(),
}));
vi.mock("module", () => ({ fn: mockFn }));
```

**Logger mock (always present):**
```typescript
vi.mock("@easyoref/shared/logger", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  flush: vi.fn(),
}));
```

**Reset mocks:**
```typescript
beforeEach(() => {
  vi.clearAllMocks();
});
```

**Assertions:** Prefer `expect(mock).toHaveBeenCalledWith(expect.objectContaining({...}))` for partial matching.

### Step 4: Choose Unit vs Integration

**Unit test** (default — no LLM, no network):
- Mock all external dependencies (`@easyoref/shared`, `grammy`, Redis, Telegram API)
- Test a single function with specific inputs → expected outputs
- Fast, deterministic, runs without API keys

**Integration test** (real LLM — add to `enrichment.integration.test.ts`):
- Uses real OpenRouter API calls
- Guard with: `it.skipIf(!HAS_API)("test name", ...)`
- Use free models only: `openai/gpt-oss-120b:free`
- Test the full pipeline or multi-node flows

**Prefer integration tests** when the bug is about LLM output quality (hallucination, wrong format, empty extraction). **Prefer unit tests** for logic bugs (guards, conditionals, data flow).

### Step 5: Run and Verify

```bash
# Run specific test file
npx vitest run packages/agent/__tests__/<file>.test.ts

# Run all tests
npm test

# Run with verbose output
npx vitest run --reporter=verbose
```

**The test MUST:**
1. Pass with the fix applied
2. Fail (or would fail) without the fix — verify by checking the assertion targets the fixed behavior
3. Not break existing tests

### Step 6: Check Total Count

After adding tests, verify total count matches expectations:
```bash
npm test 2>&1 | tail -5
```

Current baseline: **258 tests** across 17 test files. Your fix should increment this.

## Anti-patterns

- Do NOT add `confidenceThreshold`, `config.areas`, `config.language`, `config.chatIds`, `config.cityIds` to test mocks — these are v1 relics
- Do NOT test `process.env` fallbacks — config is YAML-only SSOT
- Do NOT create new test files unless testing a completely new module
- Do NOT add `@deprecated`, `legacy`, or stale TODO comments
- Do NOT mock more than needed — minimal mocks for the function under test
