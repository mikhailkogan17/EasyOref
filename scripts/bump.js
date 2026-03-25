#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const bumpType = args.find(a => a.startsWith("--bump-type="))?.split("=")[1] || "patch";

const valid = ["patch", "minor", "major"];
if (!valid.includes(bumpType)) {
  console.error(`Invalid bump type: ${bumpType}. Use: patch, minor, or major`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync("packages/bot/package.json", "utf-8"));
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
writeFileSync("packages/bot/package.json", JSON.stringify(pkg, null, 2) + "\n");

console.log(`Bumped version: ${pkg.version} → ${newVersion}`);
