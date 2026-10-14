/**
 * Unified Signed Message Protocol
 *
 * Defines the signed message interface and utilities for message creation
 * and verification using the account's Ed25519 key.
 *
 * Phase 3.2: Social & Registry Hardening
 */

import crypto from "crypto";
import { ulid } from "ulid";
import { verifyAccountSignature } from "../identity/account.js";
import { canonicalSendPayload } from "./signing.js";

/**
 * A fully signed social message.
 */
export interface SignedMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

/**
 * Create a unique message ID using ULID.
 */
export function createMessageId(): string {
  return ulid();
}

/**
 * Create a cryptographically random nonce for replay protection.
 */
export function createNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Verify the Ed25519 signature of a social message.
 *
 * The verifier needs the sender's published public key: it comes from the
 * relay envelope or from the sender's agent card / registry entry.
 */
export async function verifyMessageSignature(
  message: { to: string; content: string; signed_at: string; signature: string },
  expectedFrom: string,
  senderPublicKey?: string,
): Promise<boolean> {
  if (!senderPublicKey) return false;
  if (!expectedFrom) return false;
  try {
    const canonical = canonicalSendPayload(message.to, message.content, message.signed_at);
    return verifyAccountSignature(senderPublicKey, canonical, message.signature);
  } catch {
    return false;
  }
}
