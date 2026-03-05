/**
 * Dangerfile — PR quality checks for EasyOref
 *
 * Checks:
 * - Gitleaks secret scanning
 * - Package.json changes have lockfile update
 * - PR description exists
 */

import { danger, fail, warn } from "danger";
import { execSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";

// ── Gitleaks — secret detection ──────────────────────────
interface GitleaksFinding {
  Description: string;
  File: string;
  StartLine: number;
  Secret: string;
  RuleID: string;
}

const REPORT_PATH = "/tmp/gitleaks-report.json";

try {
  execSync(
    `gitleaks detect --source . --log-opts="origin/main..HEAD" --no-banner --report-format json --report-path ${REPORT_PATH}`,
    { stdio: "pipe" },
  );
} catch {
  // gitleaks exits 1 when secrets found
  try {
    const raw = readFileSync(REPORT_PATH, "utf-8");
    const findings: GitleaksFinding[] = JSON.parse(raw);
    for (const f of findings) {
      fail(
        `🚨 Secret detected by gitleaks in \`${f.File}\` (line ${f.StartLine}): **${f.RuleID}** — ${f.Description}`,
      );
    }
  } catch {
    fail("🚨 Gitleaks found secrets but failed to parse report.");
  } finally {
    try {
      unlinkSync(REPORT_PATH);
    } catch {
      /* ignore */
    }
  }
}

// ── PR description ───────────────────────────────────────
const allFiles = [...danger.git.created_files, ...danger.git.modified_files];

if (!danger.github.pr.body || danger.github.pr.body.length < 10) {
  warn("PR description is empty or too short. Please describe your changes.");
}

// ── Lockfile sync ────────────────────────────────────────
const packageChanged = allFiles.some((f) => f.includes("package.json"));
const lockChanged = allFiles.includes("package-lock.json");

if (packageChanged && !lockChanged) {
  warn(
    "package.json changed but package-lock.json wasn't updated. Run `npm install`.",
  );
}
