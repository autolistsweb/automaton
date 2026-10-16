/**
 * Agent Registration
 *
 * A registration is an authenticated statement made to the Conway API:
 * the automaton proves it controls its account id by signing a canonical
 * challenge with the local account key.
 *
 * The canonical form is a fixed field order joined by newlines, so any
 * party can rebuild it from the request body and verify the signature.
 */

import type { AccountIdentity } from "../identity/account.js";

export interface RegistrationChallenge {
  automatonId: string;
  accountId: string;
  creatorAccountId: string;
  name: string;
  genesisPromptHash?: string;
}

/** Canonical registration string — stable across runtime, CLI and tooling. */
export function buildRegistrationChallenge(params: RegistrationChallenge): string {
  return [
    params.automatonId,
    params.accountId,
    params.creatorAccountId,
    params.name,
    params.genesisPromptHash ?? "",
  ].join("\n");
}

/** Sign a registration challenge with the local account key. */
export async function signRegistration(
  identity: AccountIdentity,
  params: RegistrationChallenge,
): Promise<string> {
  return identity.signMessage(buildRegistrationChallenge(params));
}
