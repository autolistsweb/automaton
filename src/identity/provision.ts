/**
 * Automaton Account Provisioning
 *
 * Exchanges a signed challenge for a Conway API key. Authentication is a
 * plain challenge/response over the local account identity: there is no
 * chain, no on-chain signature and no external network identity involved.
 */

import fs from "fs";
import path from "path";
import { getAccount, getAutomatonDir } from "./account.js";
import type { ProvisionResult } from "../types.js";
import { ResilientHttpClient } from "../conway/http-client.js";

const httpClient = new ResilientHttpClient();

const DEFAULT_API_URL = "https://api.conway.tech";

/**
 * Load API key from ~/.automaton/config.json if it exists.
 */
export function loadApiKeyFromConfig(): string | null {
  const configPath = path.join(getAutomatonDir(), "config.json");
  if (!fs.existsSync(configPath)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return config.apiKey || null;
  } catch {
    return null;
  }
}

/**
 * Save API key and account id to ~/.automaton/config.json
 */
function saveConfig(apiKey: string, accountId: string): void {
  const dir = getAutomatonDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const configPath = path.join(dir, "config.json");
  const config = {
    apiKey,
    accountId,
    provisionedAt: new Date().toISOString(),
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}

/**
 * Run the provisioning flow:
 * 1. Load (or create) the local account identity
 * 2. Ask the Conway API for a nonce
 * 3. Sign the challenge with the account's Ed25519 key
 * 4. Exchange the signed challenge for a session token
 * 5. Create an API key
 * 6. Save it to config.json
 */
export async function provision(apiUrl?: string): Promise<ProvisionResult> {
  const url = apiUrl || process.env.CONWAY_API_URL || DEFAULT_API_URL;

  const { identity, accountId } = await getAccount();

  const nonceResp = await httpClient.request(`${url}/v1/auth/nonce`, {
    method: "POST",
  });
  if (!nonceResp.ok) {
    throw new Error(
      `Failed to get nonce: ${nonceResp.status} ${await nonceResp.text()}`,
    );
  }
  const { nonce } = (await nonceResp.json()) as { nonce: string };

  const message = `conway:provision:${accountId}:${nonce}`;
  const signature = await identity.signMessage(message);

  const verifyResp = await httpClient.request(`${url}/v1/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      signature,
      account_id: accountId,
      public_key: identity.publicKey,
    }),
  });

  if (!verifyResp.ok) {
    throw new Error(
      `Challenge verification failed: ${verifyResp.status} ${await verifyResp.text()}`,
    );
  }

  const { access_token } = (await verifyResp.json()) as {
    access_token: string;
  };

  const keyResp = await httpClient.request(`${url}/v1/auth/api-keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${access_token}`,
    },
    body: JSON.stringify({ name: "conway-automaton" }),
  });

  if (!keyResp.ok) {
    throw new Error(
      `Failed to create API key: ${keyResp.status} ${await keyResp.text()}`,
    );
  }

  const { key, key_prefix } = (await keyResp.json()) as {
    key: string;
    key_prefix: string;
  };

  saveConfig(key, accountId);

  return { apiKey: key, accountId, keyPrefix: key_prefix };
}

/**
 * Register the automaton's creator as its parent with Conway.
 * This allows the creator to see automaton logs and inference calls.
 */
export async function registerParent(
  creatorAccountId: string,
  apiUrl?: string,
): Promise<void> {
  const url = apiUrl || process.env.CONWAY_API_URL || DEFAULT_API_URL;
  const apiKey = loadApiKeyFromConfig();
  if (!apiKey) {
    throw new Error("Must provision API key before registering parent");
  }

  const resp = await httpClient.request(`${url}/v1/automaton/register-parent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ creatorAccountId }),
  });

  // Endpoint may not exist yet -- fail gracefully
  if (!resp.ok && resp.status !== 404) {
    throw new Error(
      `Failed to register parent: ${resp.status} ${await resp.text()}`,
    );
  }
}
