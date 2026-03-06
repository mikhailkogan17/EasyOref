#!/usr/bin/env node
/**
 * EasyOref CLI entrypoint.
 *
 *   easyoref              — run the bot (foreground)
 *   easyoref run          — same as above
 *   easyoref init         — interactive setup wizard
 *   easyoref install      — create systemd service + start
 *   easyoref uninstall    — remove systemd service
 *   easyoref start        — start service (install if needed)
 *   easyoref stop         — stop service
 *   easyoref restart      — restart service
 *   easyoref status       — show service status
 *   easyoref logs         — follow service logs
 */

const command = process.argv[2];

switch (command) {
  case "init": {
    const { init } = await import("./init.js");
    await init();
    break;
  }

  case "install": {
    const svc = await import("./service.js");
    svc.install();
    break;
  }

  case "uninstall": {
    const svc = await import("./service.js");
    svc.uninstall();
    break;
  }

  case "start": {
    const svc = await import("./service.js");
    svc.start();
    break;
  }

  case "stop": {
    const svc = await import("./service.js");
    svc.stop();
    break;
  }

  case "restart": {
    const svc = await import("./service.js");
    svc.restart();
    break;
  }

  case "status": {
    const svc = await import("./service.js");
    svc.status();
    break;
  }

  case "logs": {
    const svc = await import("./service.js");
    svc.logs();
    break;
  }

  case "--help":
  case "-h":
    console.log(`
  EasyOref — Telegram alert bot for Israeli civil defense

  Usage:
    easyoref              Run the bot (foreground)
    easyoref init         Interactive setup wizard

  Service management:
    easyoref install      Create systemd service & start
    easyoref uninstall    Remove systemd service
    easyoref start        Start service (auto-install if needed)
    easyoref stop         Stop service
    easyoref restart      Restart service
    easyoref status       Show service status
    easyoref logs         Follow service logs
`);
    break;

  case "run":
  default:
    await import("./bot.js");
}
