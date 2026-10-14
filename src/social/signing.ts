/**
 * Social Signing Module
 *
 * THE SINGLE canonical signing implementation for both runtime + CLI.
 *
 * Messages are signed with the local account's Ed25519 key, so any holder
 * of the sender's published public key can verify them. No chain, no
 * wallet, no typed data.
 *
 * Phase 3.2: Social & Registry Hardening (S-P0-1)
 */

import crypto from "crypto";
import type { SignedMessagePayload } from "../types.js";
import type { AccountIdentity } from "../identity/account.js";

export const MESSAGE_LIMITS = {
  maxContentLength: 64_000, // 64KB
  maxTotalSize: 128_000, // 128KB
  replayWindowMs: 300_000, // 5 minutes
  maxOutboundPerHour: 100,
} as const;

/** SHA-256 of the message content, lowercase hex. */
export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Canonical form of a send payload. Shared by the signer and the verifier.
 */
export function canonicalSendPayload(to: string, content: string, signedAt: string): string {
  return `Conway:send:${to}:${hashContent(content)}:${signedAt}`;
}

/**
 * Canonical form of a poll payload.
 */
export function canonicalPollPayload(accountId: string, timestamp: string): string {
  return `Conway:poll:${accountId}:${timestamp}`;
}

/**
 * Sign a send message payload.
 *
 * Canonical format:
 * `Conway:send:{to}:{sha256(content)}:{signed_at_iso}`
 */
export async function signSendPayload(
  signer: AccountIdentity,
  to: string,
  content: string,
  replyTo?: string,
): Promise<SignedMessagePayload> {
  if (content.length > MESSAGE_LIMITS.maxContentLength) {
    throw new Error(
      `Message content too long: ${content.length} bytes (max ${MESSAGE_LIMITS.maxContentLength})`,
    );
  }

  const signedAt = new Date().toISOString();
  const canonical = canonicalSendPayload(to, content, signedAt);
  const signature = await signer.signMessage(canonical);

  return {
    from: signer.accountId,
    to,
    content,
    signed_at: signedAt,
    signature,
    reply_to: replyTo,
  };
}

/**
 * Sign a poll request.
 *
 * Canonical format: `Conway:poll:{account_id}:{timestamp_iso}`
 */
export async function signPollPayload(
  signer: AccountIdentity,
): Promise<{ accountId: string; signature: string; timestamp: string }> {
  const timestamp = new Date().toISOString();
  const canonical = canonicalPollPayload(signer.accountId, timestamp);
  const signature = await signer.signMessage(canonical);

  return {
    accountId: signer.accountId,
    signature,
    timestamp,
  };
}
