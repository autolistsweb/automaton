/**
 * PixPaymentService
 *
 * The single entry point for moving money into the platform.
 *
 * Guarantees:
 *  - amounts are integer centavos of BRL, decided by the backend;
 *  - a charge only ever moves money after the provider confirms it through a
 *    signed webhook — never because the user opened or copied the Pix;
 *  - replayed or duplicated notifications credit the balance exactly once;
 *  - every movement is written to the financial ledger.
 */

import { ulid } from "ulid";
import type Database from "better-sqlite3";
import { createLogger } from "../observability/logger.js";
import { formatBRL, validateAmountCents, BRL_CURRENCY } from "./money.js";
import { isTerminalPixStatus } from "./types.js";
import type {
  PixCharge,
  PixProvider,
  PixWebhookEvent,
} from "./types.js";
import {
  creditBalance,
  expireStalePixPayments,
  getPixPaymentByExternalId,
  getPixPaymentById,
  getBalanceCents,
  hasFinancialTransaction,
  insertFinancialTransaction,
  insertPixPayment,
  listFinancialTransactions,
  listPixPayments,
  recordPixWebhookEvent,
  updatePixPaymentStatus,
} from "../state/database.js";
import type { FinancialTransactionRow, PixPaymentRow } from "../types.js";

const logger = createLogger("payments.pix");

export interface PixPaymentServiceOptions {
  db: Database.Database;
  provider: PixProvider;
  /** Default charge lifetime, in seconds. */
  ttlSeconds?: number;
}

export interface CreateChargeResult {
  charge: PixCharge;
  /** True when an identical pending charge was reused. */
  reused: boolean;
}

export class PixPaymentService {
  private readonly db: Database.Database;
  private readonly provider: PixProvider;
  private readonly ttlSeconds: number;

  constructor(options: PixPaymentServiceOptions) {
    this.db = options.db;
    this.provider = options.provider;
    this.ttlSeconds = options.ttlSeconds ?? 1800;
  }

  // ─── Balance ───────────────────────────────────────────────────

  /** Current balance in centavos. */
  getBalanceCents(userId: string): number {
    return getBalanceCents(this.db, userId);
  }

  /** Current balance formatted for the UI (e.g. `R$ 127,50`). */
  getBalanceLabel(userId: string): string {
    return formatBRL(getBalanceCents(this.db, userId));
  }

  // ─── Charges ───────────────────────────────────────────────────

  /**
   * Create a Pix charge for `amountCents`.
   *
   * The amount is validated here and never taken from an untrusted value:
   * the caller passes a requested amount, and this method decides whether it
   * is acceptable.
   */
  async createCharge(params: {
    userId: string;
    amountCents: number;
    description?: string;
  }): Promise<CreateChargeResult> {
    const { userId, amountCents } = params;

    if (!userId) {
      throw new Error("userId is required");
    }

    const amountError = validateAmountCents(amountCents);
    if (amountError) {
      throw new Error(amountError);
    }

    this.expireStaleCharges();

    const description = params.description ?? "Adição de saldo";

    // Reuse an existing pending charge for the same amount within the TTL so
    // that double-clicking the button does not create parallel charges.
    const existing = this.db
      .prepare(
        `SELECT * FROM pix_payments
         WHERE user_id = ? AND amount_cents = ? AND status = 'PENDING'
           AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(userId, amountCents) as any | undefined;

    if (existing) {
      return { charge: toCharge(deserialize(existing)), reused: true };
    }

    const reference = `pix_${ulid().toLowerCase()}`;
    const providerCharge = await this.provider.createCharge({
      reference,
      amountCents,
      description,
      expiresInSeconds: this.ttlSeconds,
    });

    if (providerCharge.amountCents !== amountCents) {
      throw new Error(
        `Provider returned amount ${providerCharge.amountCents} but ${amountCents} was requested`,
      );
    }

    const row: PixPaymentRow = {
      id: ulid(),
      userId,
      provider: this.provider.name,
      externalId: providerCharge.externalId,
      amountCents,
      currency: BRL_CURRENCY,
      status: providerCharge.status,
      pixCopyPaste: providerCharge.pixCopyPaste,
      qrCode: providerCharge.qrCode,
      description,
      expiresAt: providerCharge.expiresAt,
      paidAt: providerCharge.paidAt,
      createdAt: new Date().toISOString(),
    };

    insertPixPayment(this.db, row);
    logger.info(
      `Pix charge created: ${row.id} value=${formatBRL(amountCents)} user=${userId}`,
    );

    return { charge: toCharge(row), reused: false };
  }

  /** Load a charge by its local id. */
  getCharge(id: string): PixCharge | null {
    const row = getPixPaymentById(this.db, id);
    return row ? toCharge(row) : null;
  }

  /**
   * Consult the current status of a charge. Local state is refreshed from
   * the provider while the charge is still pending.
   */
  async getStatus(id: string): Promise<PixCharge> {
    const row = getPixPaymentById(this.db, id);
    if (!row) {
      throw new Error(`Unknown Pix charge: ${id}`);
    }

    if (row.status === "PENDING") {
      try {
        const status = await this.provider.getChargeStatus(row.externalId);
        if (status.status !== row.status) {
          if (status.status === "PAID") {
            // A provider-side payment without a webhook still requires the
            // signed notification before money moves — only mirror the state
            // here and let the webhook credit the balance.
            updatePixPaymentStatus(this.db, row.id, {
              status: "PAID",
              paidAt: status.paidAt,
            });
            row.status = "PAID";
            row.paidAt = status.paidAt;
          } else {
            updatePixPaymentStatus(this.db, row.id, { status: status.status });
            row.status = status.status;
          }
        }
      } catch (err: any) {
        logger.warn(`Failed to refresh Pix status for ${id}: ${err?.message}`);
      }
    }

    this.expireStaleCharges();
    const refreshed = getPixPaymentById(this.db, id);
    return toCharge(refreshed ?? row);
  }

  /** List recent charges for the dashboard. */
  listCharges(userId: string, limit = 20): PixCharge[] {
    return listPixPayments(this.db, userId, limit).map(toCharge);
  }

  /** Mark locally expired PENDING charges as EXPIRED. */
  expireStaleCharges(): number {
    const providerStale = expireStalePixPayments(this.db);
    if (providerStale > 0) {
      logger.info(`Expired ${providerStale} Pix charge(s)`);
    }
    return providerStale;
  }

  // ─── Webhook ───────────────────────────────────────────────────

  /**
   * Process a webhook delivery.
   *
   * Steps:
   *  1. authenticate the payload (provider signature + timestamp);
   *  2. identify the local charge;
   *  3. reject amount mismatches;
   *  4. acknowledge replayed/duplicated events as duplicates;
   *  5. mark the charge as paid and credit the balance exactly once;
   *  6. record the financial transaction.
   */
  async handleWebhook(
    payload: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ ok: true; duplicate: boolean; chargeId: string; balanceCents: number }> {
    const event = await this.provider.handleWebhook(payload, headers);

    const charge = getPixPaymentByExternalId(
      this.db,
      this.provider.name,
      event.externalId,
    );
    if (!charge) {
      throw new PixWebhookError(`Unknown charge: ${event.externalId}`, 404);
    }

    if (event.amountCents !== charge.amountCents) {
      logger.warn(
        `Webhook amount mismatch for ${charge.id}: expected ${charge.amountCents}, got ${event.amountCents}`,
      );
      throw new PixWebhookError("Amount mismatch", 422);
    }

    if (!recordPixWebhookEvent(this.db, event.eventId, this.provider.name, event.externalId)) {
      logger.info(`Duplicate webhook ignored: ${event.eventId}`);
      return {
        ok: true,
        duplicate: true,
        chargeId: charge.id,
        balanceCents: this.getBalanceCents(charge.userId),
      };
    }

    if (event.status === "PAID") {
      return this.markPaid(charge, event);
    }

    if (event.status === "EXPIRED" || event.status === "CANCELLED" || event.status === "FAILED") {
      if (!isTerminalPixStatus(charge.status) || charge.status === "PENDING") {
        updatePixPaymentStatus(this.db, charge.id, { status: event.status });
      }
      return {
        ok: true,
        duplicate: false,
        chargeId: charge.id,
        balanceCents: this.getBalanceCents(charge.userId),
      };
    }

    // PENDING notifications never move money.
    return {
      ok: true,
      duplicate: false,
      chargeId: charge.id,
      balanceCents: this.getBalanceCents(charge.userId),
    };
  }

  /**
   * Credit the balance for a confirmed payment.
   * Idempotency is keyed on the charge itself (its ledger row), never on the
   * previous status: a status poll may have already mirrored PAID locally,
   * and the webhook must still credit exactly once. A second credit is
   * impossible because the ledger row for this charge already exists.
   */
  private markPaid(
    charge: PixPaymentRow,
    event: PixWebhookEvent,
  ): { ok: true; duplicate: boolean; chargeId: string; balanceCents: number } {
    const paidAt = event.paidAt ?? charge.paidAt ?? new Date().toISOString();

    const run = this.db.transaction(() => {
      if (
        hasFinancialTransaction(this.db, charge.id, "pix_deposit")
      ) {
        logger.info(`Charge ${charge.id} already credited — ignoring repeat notification`);
        return { balanceCents: getBalanceCents(this.db, charge.userId), duplicate: true };
      }

      if (charge.status !== "PENDING" && charge.status !== "PAID") {
        throw new PixWebhookError(
          `Cannot mark a ${charge.status} charge as paid`,
          409,
        );
      }

      if (charge.status !== "PAID" || !charge.paidAt) {
        updatePixPaymentStatus(this.db, charge.id, { status: "PAID", paidAt });
      }

      const balanceCents = creditBalance(this.db, charge.userId, charge.amountCents);

      const ledgerRow: FinancialTransactionRow = {
        id: ulid(),
        userId: charge.userId,
        type: "pix_deposit",
        amountCents: charge.amountCents,
        balanceAfterCents: balanceCents,
        currency: BRL_CURRENCY,
        paymentMethod: "PIX",
        status: "COMPLETED",
        referenceId: charge.id,
        description: `Pix recebido — ${formatBRL(charge.amountCents)}`,
        createdAt: new Date().toISOString(),
      };

      const inserted = insertFinancialTransaction(this.db, ledgerRow);
      if (!inserted) {
        // Ledger row already existed: the balance must not be credited again.
        throw new Error("Transaction already recorded");
      }

      return { balanceCents, duplicate: false };
    });

    const result = run();

    if (!result.duplicate) {
      logger.info(
        `Pix confirmed: charge=${charge.id} +${formatBRL(charge.amountCents)} balance=${formatBRL(result.balanceCents)}`,
      );
    }

    return {
      ok: true,
      duplicate: result.duplicate,
      chargeId: charge.id,
      balanceCents: result.balanceCents,
    };
  }

  // ─── Statement ─────────────────────────────────────────────────

  listTransactions(userId: string, limit = 50): FinancialTransactionRow[] {
    return listFinancialTransactions(this.db, userId, limit);
  }
}

export class PixWebhookError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "PixWebhookError";
    this.statusCode = statusCode;
  }
}

function toCharge(row: PixPaymentRow): PixCharge {
  return {
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    externalId: row.externalId,
    amountCents: row.amountCents,
    currency: row.currency,
    status: row.status,
    pixCopyPaste: row.pixCopyPaste,
    qrCode: row.qrCode,
    description: row.description,
    expiresAt: row.expiresAt,
    paidAt: row.paidAt,
    createdAt: row.createdAt,
  };
}

function deserialize(row: any): PixPaymentRow {
  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    externalId: row.external_id,
    amountCents: row.amount_cents,
    currency: row.currency,
    status: row.status,
    pixCopyPaste: row.pix_copy_paste ?? null,
    qrCode: row.qr_code ?? null,
    description: row.description ?? "",
    expiresAt: row.expires_at ?? null,
    paidAt: row.paid_at ?? null,
    createdAt: row.created_at,
  };
}
