#!/usr/bin/env node
/**
 * test-ci.js — Run vitest and abort if any tests fail or are skipped.
 *
 * Skipped tests indicate missing env (e.g. OPENROUTER_API_KEY for integration
 * tests), which means not all code paths were verified. Releases must not
 * proceed in that state.
 */

import { spawnSync } from "node:child_process";

const result = spawnSync("npx", ["vitest", "run", "--reporter=verbose"], {
  stdio: ["inherit", "pipe", "pipe"],
  encoding: "utf8",
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
