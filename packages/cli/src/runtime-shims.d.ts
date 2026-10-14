declare module "@conway/automaton/config.js" {
  export interface AutomatonCliConfig {
    name: string;
    accountId: string;
    creatorAccountId: string;
    sandboxId: string;
    dbPath: string;
    inferenceModel: string;
    conwayApiUrl: string;
    conwayApiKey: string;
    openaiApiKey?: string;
    anthropicApiKey?: string;
    socialRelayUrl?: string;
  }

  export function loadConfig(): AutomatonCliConfig | null;
  export function resolvePath(p: string): string;
}

declare module "@conway/automaton/state/database.js" {
  export interface CliToolCall {
    name: string;
    result: string;
    error?: string;
  }

  export interface CliTurn {
    id: string;
    timestamp: string;
    state: string;
    input?: string;
    inputSource?: string;
    thinking: string;
    toolCalls: CliToolCall[];
    tokenUsage: { totalTokens: number };
    costCents: number;
  }

  export interface CliHeartbeatEntry {
    enabled: boolean;
  }

  export interface CliInstalledTool {
    id: string;
    name: string;
  }

  export interface AutomatonCliDatabase {
    getAgentState(): string;
    getTurnCount(): number;
    getInstalledTools(): CliInstalledTool[];
    getHeartbeatEntries(): CliHeartbeatEntry[];
    getRecentTurns(limit: number): CliTurn[];
    close(): void;
  }

  export function createDatabase(path: string): AutomatonCliDatabase;
}

declare module "@conway/automaton/identity/account.js" {
  export interface AccountIdentity {
    readonly accountId: string;
    /** Ed25519 public key, base64. Safe to publish. */
    readonly publicKey: string;
    readonly createdAt: string;
    /** Detached Ed25519 signature, base64. */
    signMessage(message: string): Promise<string>;
  }

  export function accountExists(): boolean;
  export function getAccount(): Promise<{
    identity: AccountIdentity;
    accountId: string;
    isNew: boolean;
  }>;
}

declare module "@conway/automaton/social/signing.js" {
  import type { AccountIdentity } from "@conway/automaton/identity/account.js";

  export interface SignedMessagePayload {
    from: string;
    to: string;
    content: string;
    signed_at: string;
    signature: string;
    reply_to?: string;
  }

  export function signSendPayload(
    signer: AccountIdentity,
    to: string,
    content: string,
    replyTo?: string,
  ): Promise<SignedMessagePayload>;
}
