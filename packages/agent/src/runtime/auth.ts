#!/usr/bin/env tsx
/**
 * GramJS QR Auth — run once to generate session_string.
 *
 * Usage:
 *   npx tsx packages/bot/src/agent/auth.ts
 *
 * Scan QR with burner phone → session_string printed → done.
 */

import qrcode from "qrcode-terminal";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

// Telegram Desktop public api_id/api_hash (from open-source TDesktop)
const apiId = 2040;
const apiHash = "b18441a1ff607e10a989891a5462e627";

const session = new StringSession("");
const client = new TelegramClient(session, apiId, apiHash, {
  connectionRetries: 3,
  deviceModel: "EasyOref Auth",
  appVersion: "1.0.0",
});

console.log("\n🔑 EasyOref — Telegram QR Auth\n");
console.log("Connecting to Telegram...\n");

// GramJS requires phoneNumber callback to enter QR flow.
// Throwing RESTART_AUTH_WITH_QR makes it switch to QR login.
await client.start({
  phoneNumber: async () => {
    throw { errorMessage: "RESTART_AUTH_WITH_QR" };
  },
  password: async () => "",
  phoneCode: async () => "",
  qrCode: async ({ token }) => {
    const url = `tg://login?token=${token.toString("base64url")}`;
    console.clear();
    console.log(
      "📱 Scan this QR in Telegram → Settings → Devices → Link Desktop\n",
    );
    qrcode.generate(url, { small: true });
    console.log("");
  },
  onError: (err) => {
    if (String(err).includes("RESTART_AUTH")) return Promise.resolve(true);
    console.error("Auth error:", err);
    return Promise.resolve(true);
  },
});

console.log("\n✅ Authenticated!\n");

const sessionString = client.session.save() as unknown as string;

console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("SESSION STRING (copy this to config.yaml):\n");
console.log(sessionString);
console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

await client.disconnect();
process.exit(0);
