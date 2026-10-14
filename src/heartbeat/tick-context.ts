/**
 * Tick Context
 *
 * Builds a shared context for each heartbeat tick.
 * Fetches credit and BRL balances ONCE per tick, derives survival tier,
 * and shares across all tasks to avoid redundant lookups.
 */

import type BetterSqlite3 from "better-sqlite3";

import type {
  ConwayClient,
  HeartbeatConfig,
  TickContext,
} from "../types.js";
import { getSurvivalTier } from "../conway/credits.js";
import { getBalanceCents } from "../state/database.js";
import { formatBRL } from "../payments/money.js";
import { createLogger } from "../observability/logger.js";

type DatabaseType = BetterSqlite3.Database;
const logger = createLogger("heartbeat.tick");

let counter = 0;
function generateTickId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  counter++;
  return `${timestamp}-${random}-${counter.toString(36)}`;
}

/**
 * Build a TickContext for the current tick.
 *
 * - Generates a unique tickId
 * - Fetches credit balance ONCE via conway.getCreditsBalance()
 * - Reads the BRL balance ONCE via getBalanceCents()
 * - Derives survivalTier from credit balance
 * - Reads lowComputeMultiplier from config
 */
export async function buildTickContext(
  db: DatabaseType,
  conway: ConwayClient,
  config: HeartbeatConfig,
  accountId?: string,
): Promise<TickContext> {
  const tickId = generateTickId();
  const startedAt = new Date();

  // Fetch balances ONCE
  let creditBalance = 0;
  try {
    creditBalance = await conway.getCreditsBalance();
  } catch (err: any) {
    logger.error("Failed to fetch credit balance", err instanceof Error ? err : undefined);
  }

  let balanceCents = 0;
  if (accountId) {
    try {
      balanceCents = getBalanceCents(db, accountId);
      logger.debug(`Saldo: ${formatBRL(balanceCents)}`);
    } catch (err: any) {
      logger.error("Failed to read BRL balance", err instanceof Error ? err : undefined);
    }
  }

  const survivalTier = getSurvivalTier(creditBalance);
  const lowComputeMultiplier = config.lowComputeMultiplier ?? 4;

  return {
    tickId,
    startedAt,
    creditBalance,
    balanceCents,
    survivalTier,
    lowComputeMultiplier,
    config,
    db,
  };
}
