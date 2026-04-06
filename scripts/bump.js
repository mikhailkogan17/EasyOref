#!/usr/bin/env node
import { readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

// ── Dirty-tree guard ──────────────────────────────────────
// Refuse to release if there are uncommitted or unstaged changes.
// This prevents shipping code that wasn't part of a deliberate commit.
const dirty = execSync("git status --porcelain", { encoding: "utf-8" }).trim();
if (dirty) {
  console.error("❌ Refusing to release: uncommitted changes detected.\n");
  console.error(dirty);
  console.error("\nCommit or stash your changes first.");
  process.exit(1);
}

const args = process.argv.slice(2);
const bumpType = args.find(a => a.startsWith("--bump-type="))?.split("=")[1] || "patch";

const valid = ["patch", "minor", "major"];
if (!valid.includes(bumpType)) {
  console.error(`Invalid bump type: ${bumpType}. Use: patch, minor, or major`);
  process.exit(1);
}

const packages = ["bot", "shared", "agent", "gramjs", "cli"];
const newVersions = {};

for (const pkgName of packages) {
  const path = `packages/${pkgName}/package.json`;
  const pkg = JSON.parse(readFileSync(path, "utf-8"));
  
  if (pkg.private) continue;
  
  const [major, minor, patch] = pkg.version.split(".").map(Number);
  let newVersion;
  
  if (bumpType === "major") {
    newVersion = `${major + 1}.0.0`;
  } else if (bumpType === "minor") {
    newVersion = `${major}.${minor + 1}.0`;
  } else {
    newVersion = `${major}.${minor}.${patch + 1}`;
  }
  
  pkg.version = newVersion;
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
  newVersions[pkg.name || pkgName] = newVersion;
  console.log(`${pkg.name} → ${newVersion}`);
}

// Auto commit
const versions = Object.entries(newVersions).map(([k, v]) => `${k}@${v}`).join(", ");
execSync(`git add packages/*/package.json && git commit -m "chore: bump to ${versions}"`, { stdio: "inherit" });

// Get the version from easyoref (main package)
const mainVersion = newVersions.easyoref;

// Create git tag
execSync(`git tag -a v${mainVersion} -m "Release v${mainVersion}"`, { stdio: "inherit" });
console.log(`\n✅ Bumped ${packages.length} packages to ${bumpType}`);
console.log(`✅ Created git tag: v${mainVersion}`);
