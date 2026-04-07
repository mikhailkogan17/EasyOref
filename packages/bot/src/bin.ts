#!/usr/bin/env node
/**
 * EasyOref CLI entrypoint.
 *
 *   easyoref              — run the bot (foreground)
 *   easyoref run          — same as above
 *   easyoref init         — interactive setup wizard
 *   easyoref update       — update to latest version & restart all services
 *   easyoref install      — install systemd service(s) for all configs in ~/.easyoref/
 *   easyoref uninstall [name] — remove service(s)
 *   easyoref start    [name] — start service(s)
 *   easyoref stop     [name] — stop service(s)
 *   easyoref restart  [name] — restart service(s)
 *   easyoref status   [name] — show service status
 *   easyoref logs     [name] — follow service logs
 */

import { execSync } from "node:child_process";

const command = process.argv[2];
const arg = process.argv[3]; // optional instance name for service commands

switch (command) {
  case "init": {
    const { init } = await import("./init.js");
    await init();
    break;
  }

  case "update": {
    console.log("\n🚀 Updating EasyOref...\n");
    try {
      console.log("  → sudo npm install -g easyoref@latest");
      execSync("sudo npm install -g easyoref@latest", { stdio: "inherit" });

      // Ensure redis is running
      try {
        execSync(
          "docker inspect easyoref-redis --format '{{.State.Running}}' 2>/dev/null | grep -q true",
          { stdio: "pipe" },
        );
        console.log("\n  → redis already running");
      } catch {
        console.log("\n  → docker run redis");
        execSync(
          "docker run -d --name easyoref-redis --restart unless-stopped " +
            "-v easyoref-redis:/data " +
            "redis:7-alpine redis-server --appendonly yes --maxmemory 64mb --maxmemory-policy allkeys-lru",
          { stdio: "inherit" },
        );
      }

      // Kill any stale node process occupying port 3100 before restart
      try {
        execSync("sudo fuser -k 3100/tcp 2>/dev/null || true", { stdio: "pipe" });
      } catch {
        // ignore — port may not be in use
      }

      // Restart all discovered instances
      const svc = await import("./service.js");
      console.log("\n  → restarting all instances...");
      svc.restart();

      console.log("\n✅ EasyOref updated successfully!");
    } catch (err) {
      console.error("\n❌ Update failed:", err);
      process.exit(1);
    }
    break;
  }

  case "install": {
    const svc = await import("./service.js");
    svc.install();
    break;
  }

  case "uninstall": {
    const svc = await import("./service.js");
    svc.uninstall(arg);
    break;
  }

  case "start": {
    const svc = await import("./service.js");
    svc.start(arg);
    break;
  }

  case "stop": {
    const svc = await import("./service.js");
    svc.stop(arg);
    break;
  }

  case "restart": {
    const svc = await import("./service.js");
    svc.restart(arg);
    break;
  }

  case "status": {
    const svc = await import("./service.js");
    svc.status(arg);
    break;
  }

  case "logs": {
    const svc = await import("./service.js");
    svc.logs(arg);
    break;
  }

  case "--help":
  case "-h":
    console.log(`
  EasyOref — Telegram alert bot for Israeli civil defense

  Usage:
    easyoref              Run the bot (foreground)
    easyoref init         Interactive setup wizard
    easyoref update       Update to latest version & restart all services

  Service management (multi-instance aware):
    easyoref install              Install service(s) for all configs in ~/.easyoref/
    easyoref uninstall [name]     Remove service(s)
    easyoref start     [name]     Start service(s)
    easyoref stop      [name]     Stop service(s)
    easyoref restart   [name]     Restart service(s)
    easyoref status    [name]     Show service status
    easyoref logs      [name]     Follow service logs

  [name] is optional. If omitted, applies to all configured instances.
  Example: easyoref restart ru_tlv-south
`);
    break;

  case "run":
  default:
    await import("./bot.js");
}
