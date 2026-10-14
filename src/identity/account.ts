/**
 * Account Identity
 *
 * The automaton's identity is a locally generated **account**: a public
 * identifier (`acct_…`) plus an Ed25519 signing key used to authenticate
 * API calls and to sign social messages so that anyone holding the public
 * key can verify them.
 *
 * This is ordinary authentication material — the same kind of key used by
 * SSH or TLS client certificates. There is no blockchain wallet here: no
 * seed phrase, no chain, no address, no RPC, and nothing that can hold or
 * transfer a coin.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

const AUTOMATON_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "/root",
  ".automaton",
);
const ACCOUNT_FILE = path.join(AUTOMATON_DIR, "account.json");

export interface AccountData {
  accountId: string;
  /** Ed25519 public key, base64. Safe to publish. */
  publicKey: string;
  /** Ed25519 signing key, base64. Kept with 0600 permissions, never shared. */
  signingKey: string;
  createdAt: string;
}

/**
 * Chain-free account identity. `accountId` replaces the old wallet
 * address everywhere in the runtime.
 */
export interface AccountIdentity {
  readonly accountId: string;
  readonly publicKey: string;
  readonly createdAt: string;
  /** Detached Ed25519 signature, base64. */
  signMessage(message: string): Promise<string>;
}

/** Account ids are `acct_` + lowercase hex. */
const ACCOUNT_ID_RE = /^acct_[0-9a-f]{16,64}$/;

export function getAutomatonDir(): string {
  return AUTOMATON_DIR;
}

export function getAccountPath(): string {
  return ACCOUNT_FILE;
}

export function accountExists(): boolean {
  return fs.existsSync(ACCOUNT_FILE);
}

/** Generate a public account identifier. */
export function createAccountId(): string {
  return `acct_${crypto.randomBytes(12).toString("hex")}`;
}

/**
 * Structural check for an account id. Used to validate `from`/`to` fields
 * on social messages and to reject malformed ids before they reach storage.
 */
export function isValidAccountId(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_ID_RE.test(value);
}

function readAccountFile(): AccountData | null {
  if (!fs.existsSync(ACCOUNT_FILE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(ACCOUNT_FILE, "utf-8")) as AccountData;
    if (!parsed.accountId || !parsed.signingKey || !parsed.publicKey) return null;
    return parsed;
  } catch {
    return null;
  }
}

function buildIdentity(data: AccountData): AccountIdentity {
  const key = crypto.createPrivateKey({
    key: Buffer.from(data.signingKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return {
    accountId: data.accountId,
    publicKey: data.publicKey,
    createdAt: data.createdAt,
    async signMessage(message: string): Promise<string> {
      return crypto.sign(null, Buffer.from(message, "utf8"), key).toString("base64");
    },
  };
}

/**
 * Verify an account signature against a published public key.
 * Constant-time not required here: public verification exposes no secret.
 */
export function verifyAccountSignature(
  publicKeyBase64: string,
  message: string,
  signatureBase64: string,
): boolean {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      format: "der",
      type: "spki",
    });
    return crypto.verify(
      null,
      Buffer.from(message, "utf8"),
      key,
      Buffer.from(signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
}

/**
 * Get or create the automaton's account identity.
 */
export async function getAccount(): Promise<{
  identity: AccountIdentity;
  accountId: string;
  isNew: boolean;
}> {
  const existing = readAccountFile();
  if (existing) {
    return { identity: buildIdentity(existing), accountId: existing.accountId, isNew: false };
  }

  if (!fs.existsSync(AUTOMATON_DIR)) {
    fs.mkdirSync(AUTOMATON_DIR, { recursive: true, mode: 0o700 });
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

  const data: AccountData = {
    accountId: createAccountId(),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    signingKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });

  return { identity: buildIdentity(data), accountId: data.accountId, isNew: true };
}

/** Read the account id without loading the signing key. */
export function getAccountId(): string | null {
  return readAccountFile()?.accountId ?? null;
}

/** Read the published public key of the local account. */
export function getAccountPublicKey(): string | null {
  return readAccountFile()?.publicKey ?? null;
}

/**
 * Legacy wallet file from earlier releases. Wallets are no longer part of
 * the platform; the file is ignored and never read.
 */
export function legacyWalletPath(): string {
  return path.join(AUTOMATON_DIR, "wallet.json");
}
