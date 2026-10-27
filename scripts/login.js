// Interactive Telegram MTProto login — run:  npm run login
// Prompts for phone -> SMS code -> (optional) 2FA password.
// Prints a session string you paste into TELEGRAM_SESSION (.env or Render env vars).
const { TelegramClient } = require("teleproto");
const { StringSession } = require("teleproto/sessions");
const readline = require("readline");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const q = (p) => new Promise((r) => rl.question(p, r));

async function main() {
  const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!apiId || !apiHash) {
    console.error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH first (see .env.example).");
    process.exit(1);
  }

  const session = new StringSession("");
  const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });
  await client.connect();

  await client.start({
    phoneNumber: () => q("Phone number (e.g. +919876543210): "),
    phoneCode: () => q("Code (from SMS): "),
    password: () => q("2FA password (press Enter if none): "),
    onError: (e) => console.error("Login error:", e),
  });

  const me = await client.getMe();
  console.log("\nLogged in as:", me.firstName, me.username ? `@${me.username}` : `(${me.id})`);
  console.log("\n===== COPY THIS SESSION STRING =====");
  console.log(client.session.save());
  console.log("====================================\n");
  console.log("Add it as TELEGRAM_SESSION in your .env or Render environment variables.");

  await client.disconnect();
  rl.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
