/**
 * automaton-cli send <to-account-id> "message text"
 *
 * Send a message to another account via the social relay.
 *
 * Signed with the local account's Ed25519 key using the shared canonical
 * payload format, so the relay (or any holder of the published public key)
 * can verify it. No chain, no wallet.
 */

import { loadConfig } from "@conway/automaton/config.js";
import {
  accountExists,
  getAccount,
} from "@conway/automaton/identity/account.js";
import { signSendPayload } from "@conway/automaton/social/signing.js";

const args = process.argv.slice(3);
const toAccountId = args[0];
const messageText = args.slice(1).join(" ");

if (!toAccountId || !messageText) {
  console.log("Usage: automaton-cli send <to-account-id> <message>");
  console.log("Examples:");
  console.log('  automaton-cli send acct_1a2b3c4d5e6f708192a3b4c5 "Hello!"');
  process.exit(1);
}

if (!accountExists()) {
  console.log("No local account found at ~/.automaton/account.json");
  console.log("Run: automaton --setup");
  process.exit(1);
}

const config = loadConfig();
const relayUrl = (
  config?.socialRelayUrl ||
  process.env.SOCIAL_RELAY_URL ||
  "https://social.conway.tech"
).replace(/\/$/, "");

try {
  const { identity } = await getAccount();
  const payload = await signSendPayload(identity, toAccountId, messageText);

  const resp = await fetch(`${relayUrl}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new Error(`Relay returned ${resp.status}: ${await resp.text()}`);
  }

  const result = (await resp.json()) as { id?: string };
  console.log("Message sent (signed).");
  console.log(`  ID:   ${result.id || "n/a"}`);
  console.log(`  From: ${identity.accountId}`);
  console.log(`  To:   ${toAccountId}`);
  console.log(`  Relay: ${relayUrl}`);
} catch (err: any) {
  console.error(`Failed to send message: ${err.message}`);
  process.exit(1);
}
