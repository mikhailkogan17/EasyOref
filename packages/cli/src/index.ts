#! /usr/bin/env node
/**
 * @easyoref/cli — Interactive setup wizard
 *
 * Usage:
 *   npx @easyoref/cli init         — interactive setup
 *   npx @easyoref/cli list-areas   — show all Oref area names
 *   npx @easyoref/cli update        — update RPi deployment
 */

import chalk from "chalk";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { init } from "./commands/init.js";
import { listAreas } from "./commands/list-areas.js";

const command = process.argv[2];
const args = process.argv.slice(3);

async function main(): Promise<void> {
  console.log(chalk.bold("\n🚨 EasyOref — Setup Wizard\n"));

  switch (command) {
    case "init":
    case undefined:
      await init();
      break;
    case "list-areas":
      listAreas();
      break;
    case "update":
      update(args[0]);
      break;
    case "--help":
    case "-h":
      printHelp();
      break;
    default:
      console.log(chalk.red(`Unknown command: ${command}`));
      printHelp();
      process.exit(1);
  }
}

function printHelp(): void {
  console.log(`${chalk.bold("Commands:")}
  ${chalk.cyan("init")}                  Interactive setup wizard (default)
  ${chalk.cyan("list-areas")}           Show all Oref area names with translations
  ${chalk.cyan("update")}                Update RPi deployment
  ${chalk.cyan("update /path/to/deploy")} Update in specific directory
  ${chalk.cyan("--help")}                Show this help message
`);
}

function update(path?: string): void {
  const targetPath = path 
    ? resolve(path)
    : "/home/pi/EasyOref";

  const composePath = resolve(targetPath, "docker-compose.yml");

  if (!existsSync(composePath)) {
    console.log(chalk.yellow(`No docker-compose.yml found in: ${targetPath}`));
    console.log(chalk.gray("Usage: easyoref update /path/to/deployment"));
    process.exit(1);
  }

  console.log(chalk.cyan(`Updating EasyOref in: ${targetPath}...\n`));

  try {
    console.log(chalk.gray("  → npm update --legacy-peer-deps"));
    execSync("npm update --legacy-peer-deps", { cwd: targetPath, stdio: "inherit" });

    console.log(chalk.gray("\n  → npm uninstall -g easyoref @easyoref/cli 2>/dev/null; npm install -g @easyoref/cli"));
    execSync("npm uninstall -g easyoref @easyoref/cli 2>/dev/null; npm install -g @easyoref/cli", { stdio: "inherit" });

    console.log(chalk.gray("\n  → docker compose down"));
    execSync("docker compose down", { cwd: targetPath, stdio: "inherit" });

    console.log(chalk.gray("\n  → docker compose up --build -d"));
    execSync("docker compose up --build -d", { cwd: targetPath, stdio: "inherit" });

    console.log(chalk.green("\n✅ EasyOref updated successfully!"));
  } catch (err) {
    console.error(chalk.red("\n❌ Update failed:"), err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(chalk.red("Fatal error:"), err);
  process.exit(1);
});
