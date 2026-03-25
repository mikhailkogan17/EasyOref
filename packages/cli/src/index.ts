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
      update();
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
  ${chalk.cyan("init")}         Interactive setup wizard (default)
  ${chalk.cyan("list-areas")}  Show all Oref area names with translations
  ${chalk.cyan("update")}      Update RPi deployment (docker compose down && up --build)
  ${chalk.cyan("--help")}      Show this help message
`);
}

function update(): void {
  const composePath = resolve(process.cwd(), "docker-compose.yml");
  const envPath = resolve(process.cwd(), ".env");

  if (!existsSync(composePath)) {
    console.log(chalk.yellow("No docker-compose.yml found in current directory."));
    console.log(chalk.gray("Run from your project or deployment directory."));
    process.exit(1);
  }

  console.log(chalk.cyan("Updating EasyOref...\n"));

  try {
    console.log(chalk.gray("  → docker compose down"));
    execSync("docker compose down", { stdio: "inherit" });

    console.log(chalk.gray("\n  → docker compose up --build -d"));
    execSync("docker compose up --build -d", { stdio: "inherit" });

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
