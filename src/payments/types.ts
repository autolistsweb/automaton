/**
 * Pix Payment Types
 *
 * The platform's financial system works exclusively with Brazilian Real
 * (BRL) funded through Pix. Money is always an integer in centavos.
 */

import type { BrlCurrency } from "./money.js";
import type {
  FinancialTransactionRow,
  PixChargeStatus,
  PixPaymentRow,
  UserBalanceRow,
} from "../types.js";

export type { PixChargeStatus, PixPaymentRow, UserBalanceRow };

/**
 * The user facing financial statement entry.
 * All amounts are integer centavos of BRL.
 */
export type FinancialTransaction = FinancialTransactionRow;

// ─── Charge lifecycle ────────────────────────────────────────────

/**
 * Lifecycle of a Pix charge. A charge is only ever credited to the
 * user's balance after the provider confirms it through the webhook
 * with status PAID. Opening or copying the Pix never confirms it.
 */
export const PIX_CHARGE_STATUSES: readonly PixChargeStatus[] = [
  "PENDING",
  "PAID",
  "EXPIRED",
  "CANCELLED",
  "FAILED",
];

/** Terminal statuses: they can never transition again. */
export const TERMINAL_PIX_STATUSES: readonly PixChargeStatus[] = [
  "PAID",
  "EXPIRED",
  "CANCELLED",
  "FAILED",
];

export function isTerminalPixStatus(status: string): boolean {
  return (TERMINAL_PIX_STATUSES as readonly string[]).includes(status);
}

// ─── Persisted charge ────────────────────────────────────────────

export interface PixCharge {
  id: string;
  userId: string;
  provider: string;
  externalId: string;
  amountCents: number;
  currency: BrlCurrency;
  status: PixChargeStatus;
  /** Pix "copia e cola" payload (EMV BR Code). */
  pixCopyPaste: string | null;
  /** QR Code rendering, usually an SVG data URI. */
  qrCode: string | null;
  description: string;
  expiresAt: string | null;
  paidAt: string | null;
  createdAt: string;
}

// ─── Provider contract ───────────────────────────────────────────

export interface CreatePixChargeParams {
  /** Caller supplied idempotency/reference key, unique per provider. */
  reference: string;
  amountCents: number;
  description?: string;
  expiresInSeconds?: number;
}

export interface PixProviderCharge {
  externalId: string;
  amountCents: number;
  status: PixChargeStatus;
  pixCopyPaste: string;
  qrCode: string;
  expiresAt: string | null;
  paidAt: string | null;
}

export type PixProviderStatus = Pick<
  PixProviderCharge,
  "externalId" | "amountCents" | "status" | "paidAt"
>;

/**
 * Normalized notification produced by a provider after signature
 * verification. This is the ONLY input the payment service trusts
 * to move money.
 */
export interface PixWebhookEvent {
  /** Provider-side event id, used for replay/duplicate protection. */
  eventId: string;
  externalId: string;
  status: PixChargeStatus;
  amountCents: number;
  paidAt: string | null;
}

/**
 * Rejection raised while authenticating a webhook delivery: missing or
 * invalid signature, missing/invalid timestamp or a stale replay window.
 *
 * Malformed payloads are raised with `statusCode` 400. The webhook server
 * maps this error to the given HTTP status instead of a generic 500.
 */
export class PixWebhookAuthError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number = 401) {
    super(message);
    this.name = "PixWebhookAuthError";
    this.statusCode = statusCode;
  }
}

/**
 * Provider-agnostic contract.
 *
 * Implementations: MockPixProvider (development/tests), and adapters for
 * Mercado Pago, Efí Bank, Asaas, PagBank, or any other Pix gateway.
 */
export interface PixProvider {
  readonly name: string;
  createCharge(params: CreatePixChargeParams): Promise<PixProviderCharge>;
  getChargeStatus(externalId: string): Promise<PixProviderStatus>;
  /**
   * Validate authenticity of a webhook delivery and return the normalized
   * event. Must throw `PixWebhookAuthError` on invalid signatures or
   * timestamps, and reject unknown charges or tampered amounts.
   * Redeliveries must be returned normally: replay/duplicate protection is
   * keyed on `eventId` by the payment service, so a retried delivery is
   * acknowledged as a duplicate instead of being rejected.
   */
  handleWebhook(
    payload: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<PixWebhookEvent>;
}

// ─── Financial transactions ──────────────────────────────────────

export type PaymentMethod = "PIX";

export type FinancialTransactionType =
  | "pix_deposit"
  | "service_usage"
  | "transfer_in"
  | "transfer_out"
  | "credit_purchase";

export type FinancialTransactionStatus = "PENDING" | "COMPLETED" | "FAILED" | "CANCELLED";

// ─── Balance ─────────────────────────────────────────────────────
