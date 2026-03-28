#!/usr/bin/env node
/**
 * test-ci.js — Run vitest and abort if any tests fail or are skipped.
 *
 * Skipped tests indicate missing env (e.g. OPENROUTER_API_KEY for integration
 * tests), which means not all code paths were verified. Releases must not
 * proceed in that state.
 *
 * API key loading order:
 *   1. OPENROUTER_API_KEY env var
 *   2. config.yaml (ai.openrouter_api_key)
 *   3. Any config.*.yaml in the repo root
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

// ── Load API key if not already in env ─────────────────────
if (!process.env.OPENROUTER_API_KEY) {
  const candidates = ["config.yaml", ...readdirSync(".").filter((f) => /^config\..+\.yaml$/.test(f))];
  for (const file of candidates) {
    try {
      const { load } = await import("js-yaml");
      const raw = readFileSync(file, "utf-8");
      const cfg = load(raw);
      const key = cfg?.ai?.openrouter_api_key;
      if (key) {
        process.env.OPENROUTER_API_KEY = key;
        break;
      }
    } catch {
      // skip unreadable files
    }
  }
}

const result = spawnSync("npx", ["vitest", "run", "--reporter=verbose"], {
  stdio: ["inherit", "pipe", "pipe"],
  encoding: "utf8",
  env: process.env,
});

const output = (result.stdout ?? "") + (result.stderr ?? "");

// Print output so the user sees test results
process.stdout.write(output);

if (result.status !== 0) {
  console.error("\nERROR: Tests failed — aborting release.");
  process.exit(1);
}

// vitest reports skipped as "X skipped" in the summary line
const skippedMatch = output.match(/(\d+)\s+skipped/);
if (skippedMatch && parseInt(skippedMatch[1], 10) > 0) {
  console.error(
    `\nERROR: ${skippedMatch[1]} test(s) were skipped — aborting release.`,
    "\nSet OPENROUTER_API_KEY to run all integration tests.",
  );
  process.exit(1);
}

console.log("\nAll tests passed. Proceeding with release.");
