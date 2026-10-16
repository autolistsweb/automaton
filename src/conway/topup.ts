/**
 * Credit Topup
 *
 * Conway compute credits are bought with the account's BRL balance.
 * The balance itself is only ever increased by an inbound Pix confirmed
 * through the payment webhook — there is no coin, chain or external token
 * involved anywhere in this path.
 *
 * On startup: `bootstrapTopup` buys the minimum tier when credits are low
 * and the BRL balance covers it.
 * At runtime: the agent uses the `topup_credits` tool to choose a tier.
 * On a 402/insufficient-credit sandbox error: `topupForSandbox` picks the
 * smallest tier that covers the deficit.
 *
 * All amounts are integer centavos of BRL.
 */

import type Database from "better-sqlite3";
import { createLogger } from "../observability/logger.js";
import { formatBRL, validateAmountCents, BRL_CURRENCY } from "../payments/money.js";
import {
  creditBalance,
  debitBalance,
  getBalanceCents,
  hasFinancialTransaction,
  insertFinancialTransaction,
} from "../state/database.js";
import { ulid } from "ulid";
import type { ConwayClient, FinancialTransactionRow } from "../types.js";

const logger = createLogger("topup");

/** Valid topup tiers in centavos of BRL (R$ 10 … R$ 500). */
export const TOPUP_TIERS_CENTS = [1000, 2500, 5000, 10000, 25000, 50000];

/** Smallest tier — the default bootstrap amount. */
export const MIN_TOPUP_CENTS = TOPUP_TIERS_CENTS[0];
/** Largest tier accepted without an explicit policy override. */
export const MAX_TOPUP_CENTS = TOPUP_TIERS_CENTS[TOPUP_TIERS_CENTS.length - 1];

export interface TopupResult {
  success: boolean;
  /** BRL centavos taken from the account balance. */
  amountCents: number;
  creditsCentsAdded?: number;
  balanceCents?: number;
  error?: string;
}

function pickTier(deficitCents: number): number {
  return (
    TOPUP_TIERS_CENTS.find((tier) => tier >= deficitCents) ??
    MAX_TOPUP_CENTS
  );
}

/**
 * Buy Conway credits with the account's BRL balance.
 *
 * Order of operations (fail-safe):
 *  1. validate the amount;
 *  2. debit the BRL balance (refuses to go negative);
 *  3. call the Conway credits API;
 *  4. refund the balance and record a FAILED ledger entry if step 3 fails.
 *
 * The ledger entry reference is stable per call, so a retried purchase with
 * the same reference cannot be recorded twice.
 */
export async function purchaseCredits(params: {
  db: Database.Database;
  userId: string;
  amountCents: number;
  conway: ConwayClient;
  description?: string;
}): Promise<TopupResult> {
  const { db, userId, amountCents, conway } = params;

  const amountError = validateAmountCents(amountCents, {
    min: MIN_TOPUP_CENTS,
    max: MAX_TOPUP_CENTS,
  });
  if (amountError) {
    return { success: false, amountCents, error: amountError };
  }

  if (amountCents % 100 !== 0) {
    return {
      success: false,
      amountCents,
      error: "Credit topup must use a whole-real tier (multiples of R$ 1,00)",
    };
  }

  const referenceId = `crd_${ulid().toLowerCase()}`;

  let balanceCents: number;
  try {
    balanceCents = debitBalance(db, userId, amountCents);
  } catch (err: any) {
    return {
      success: false,
      amountCents,
      error: err?.message === "Insufficient balance"
        ? `Saldo insuficiente: ${formatBRL(getBalanceCents(db, userId))} disponível`
        : err?.message,
    };
  }

  try {
    const result = await conway.purchaseCredits(amountCents, referenceId);

    const ledgerRow: FinancialTransactionRow = {
      id: ulid(),
      userId,
      type: "credit_purchase",
      amountCents: -amountCents,
      balanceAfterCents: balanceCents,
      currency: BRL_CURRENCY,
      paymentMethod: "PIX",
      status: "COMPLETED",
      referenceId,
      description:
        params.description ??
        `Compra de créditos — ${formatBRL(amountCents)}`,
      createdAt: new Date().toISOString(),
    };
    if (!hasFinancialTransaction(db, referenceId, "credit_purchase")) {
      insertFinancialTransaction(db, ledgerRow);
    }

    logger.info(
      `Credit topup: -${formatBRL(amountCents)} balance=${formatBRL(balanceCents)} credits=+${result.creditsCentsAdded}`,
    );

    return {
      success: true,
      amountCents,
      creditsCentsAdded: result.creditsCentsAdded,
      balanceCents,
    };
  } catch (err: any) {
    // Refund: the money never bought credits.
    let refundBalance = balanceCents;
    try {
      refundBalance = creditBalance(db, userId, amountCents);
    } catch (refundErr: any) {
      logger.error(`Credit topup refund failed: ${refundErr?.message}`);
    }

    if (!hasFinancialTransaction(db, referenceId, "credit_purchase")) {
      insertFinancialTransaction(db, {
        id: ulid(),
        userId,
        type: "credit_purchase",
        amountCents: 0,
        balanceAfterCents: refundBalance,
        currency: BRL_CURRENCY,
        paymentMethod: "PIX",
        status: "FAILED",
        referenceId,
        description: `Compra de créditos falhou — ${formatBRL(amountCents)} devolvido`,
        createdAt: new Date().toISOString(),
      });
    }

    logger.warn(
      `Credit topup failed: ${err?.message} (refunded ${formatBRL(amountCents)})`,
    );

    return {
      success: false,
      amountCents,
      balanceCents: refundBalance,
      error: err?.message ?? "credit topup failed",
    };
  }
}

/**
 * Attempt a credit topup in response to a 402 / INSUFFICIENT_CREDITS
 * sandbox creation error.
 *
 * Parses the error to find the deficit, picks the smallest tier that covers
 * it and checks the BRL balance before spending. Returns `null` when the
 * error is unrelated or the balance cannot cover the tier.
 */
export async function topupForSandbox(params: {
  db: Database.Database;
  userId: string;
  conway: ConwayClient;
  error: Error & { status?: number; responseText?: string };
}): Promise<TopupResult | null> {
  const { db, userId, conway, error } = params;

  if (error.status !== 402 && !error.message?.includes("INSUFFICIENT_CREDITS")) {
    return null;
  }

  let requiredCents: number | undefined;
  let currentCents: number | undefined;
  try {
    const body = JSON.parse(error.responseText || "{}");
    requiredCents = body.details?.required_cents;
    currentCents = body.details?.current_balance_cents;
  } catch {
    if (!error.message?.includes("INSUFFICIENT_CREDITS")) return null;
  }

  const deficitCents =
    requiredCents != null && currentCents != null
      ? requiredCents - currentCents
      : MIN_TOPUP_CENTS;

  const selectedTier = pickTier(deficitCents);

  const balanceCents = getBalanceCents(db, userId);
  if (balanceCents < selectedTier) {
    logger.info(
      `Sandbox topup skipped: balance ${formatBRL(balanceCents)} < tier ${formatBRL(selectedTier)}`,
    );
    return null;
  }

  logger.info(
    `Sandbox topup: deficit=${deficitCents}c, buying ${formatBRL(selectedTier)} of credits`,
  );

  return purchaseCredits({ db, userId, amountCents: selectedTier, conway });
}

/**
 * Bootstrap topup: buy the minimum tier on startup so the agent can run
 * inference. The agent decides larger topups itself via `topup_credits`.
 *
 * Only triggers when credits are below the threshold AND the BRL balance
 * covers the minimum tier.
 */
export async function bootstrapTopup(params: {
  db: Database.Database;
  userId: string;
  conway: ConwayClient;
  creditsCents: number;
  creditThresholdCents?: number;
}): Promise<TopupResult | null> {
  const {
    db,
    userId,
    conway,
    creditsCents,
    creditThresholdCents = 500,
  } = params;

  if (creditsCents >= creditThresholdCents) {
    return null;
  }

  const balanceCents = getBalanceCents(db, userId);
  if (balanceCents < MIN_TOPUP_CENTS) {
    logger.info(
      `Bootstrap topup skipped: balance ${formatBRL(balanceCents)} below minimum tier ${formatBRL(MIN_TOPUP_CENTS)}`,
    );
    return null;
  }

  logger.info(
    `Bootstrap topup: credits=${creditsCents}c, balance=${formatBRL(balanceCents)}, buying ${formatBRL(MIN_TOPUP_CENTS)}`,
  );

  return purchaseCredits({ db, userId, amountCents: MIN_TOPUP_CENTS, conway });
}
