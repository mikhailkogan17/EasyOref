/**
 * EasyOref — systemd service management (à la Homebridge)
 *
 *   easyoref install   — create & enable systemd service, then start
 *   easyoref uninstall — stop & remove systemd service
 *   easyoref start     — start the service (install first if needed)
 *   easyoref stop      — stop the service
 *   easyoref restart   — restart the service
 *   easyoref status    — show service status
 *   easyoref logs      — follow journal logs
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SERVICE_NAME = "easyoref";
const UNIT_PATH = `/etc/systemd/system/${SERVICE_NAME}.service`;
const CONFIG_DIR = join(homedir(), ".easyoref");
const CONFIG_PATH = join(CONFIG_DIR, "config.yaml");

function whichBin(): string {
  try {
    return execSync("which easyoref", { encoding: "utf-8" }).trim();
  } catch {
    // Fallback: resolve from npm global
    try {
      return execSync("npm bin -g", { encoding: "utf-8" }).trim() + "/easyoref";
    } catch {
      return "/usr/bin/easyoref";
    }
  }
}

function whichNode(): string {
  try {
    return execSync("which node", { encoding: "utf-8" }).trim();
  } catch {
    return "/usr/bin/node";
  }
}

function isRoot(): boolean {
  return process.getuid?.() === 0;
}

function sudoExec(cmd: string): void {
  const result = spawnSync("sudo", cmd.split(" "), {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`❌ Command failed: sudo ${cmd}`);
    process.exit(1);
  }
}

function exec(cmd: string): void {
  const result = spawnSync(cmd.split(" ")[0], cmd.split(" ").slice(1), {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function isInstalled(): boolean {
  return existsSync(UNIT_PATH);
}

function generateUnit(): string {
  const bin = whichBin();
  const node = whichNode();
  const user = process.env.USER || process.env.LOGNAME || "pi";
  const home = homedir();

  return `[Unit]
Description=EasyOref Telegram Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
Environment=HOME=${home}
Environment=NODE_ENV=production
ExecStart=${node} ${bin} run
WorkingDirectory=${home}
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
`;
}

// ── Commands ─────────────────────────────────────────────

export function install(): void {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`❌ Config not found at ${CONFIG_PATH}`);
    console.error(`   Run: easyoref init`);
    process.exit(1);
  }

  console.log(`📦 Installing ${SERVICE_NAME} systemd service...`);

  const unit = generateUnit();
  const tmpPath = `/tmp/${SERVICE_NAME}.service`;
  writeFileSync(tmpPath, unit);

  sudoExec(`cp ${tmpPath} ${UNIT_PATH}`);
  sudoExec("systemctl daemon-reload");
  sudoExec(`systemctl enable ${SERVICE_NAME}`);
  sudoExec(`systemctl start ${SERVICE_NAME}`);

  console.log(`✅ Service installed and started`);
  console.log(`   Config: ${CONFIG_PATH}`);
  console.log(`   Logs:   easyoref logs`);
  console.log(`   Status: easyoref status`);
}

export function uninstall(): void {
  if (!isInstalled()) {
    console.log("ℹ️  Service not installed");
    return;
  }

  console.log(`🗑  Removing ${SERVICE_NAME} systemd service...`);

  sudoExec(`systemctl stop ${SERVICE_NAME}`);
  sudoExec(`systemctl disable ${SERVICE_NAME}`);
  sudoExec(`rm ${UNIT_PATH}`);
  sudoExec("systemctl daemon-reload");

  console.log("✅ Service removed");
}

export function start(): void {
  if (!isInstalled()) {
    console.log("Service not installed — installing first...");
    install();
    return;
  }
  sudoExec(`systemctl start ${SERVICE_NAME}`);
  console.log("✅ Started");
}

export function stop(): void {
  if (!isInstalled()) {
    console.log("ℹ️  Service not installed");
    return;
  }
  sudoExec(`systemctl stop ${SERVICE_NAME}`);
  console.log("✅ Stopped");
}

export function restart(): void {
  if (!isInstalled()) {
    console.log("Service not installed — installing first...");
    install();
    return;
  }
  sudoExec(`systemctl restart ${SERVICE_NAME}`);
  console.log("✅ Restarted");
}

export function status(): void {
  if (!isInstalled()) {
    console.log("ℹ️  Service not installed. Run: easyoref install");
    return;
  }
  spawnSync("systemctl", ["status", SERVICE_NAME, "--no-pager"], {
    stdio: "inherit",
  });
}

export function logs(): void {
  if (!isInstalled()) {
    console.log("ℹ️  Service not installed. Run: easyoref install");
    return;
  }
  spawnSync(
    "journalctl",
    ["-u", SERVICE_NAME, "-f", "--no-pager", "-o", "cat"],
    {
      stdio: "inherit",
    },
  );
}
