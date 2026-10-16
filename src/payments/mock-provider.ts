/**
 * MockPixProvider
 *
 * Development/test Pix gateway. It never touches real money: charges are
 * created with a syntactically valid BR Code, and payment confirmation only
 * happens through an explicitly signed webhook delivery (or an explicit
 * `simulatePayment()` call in tests).
 */

import crypto from "crypto";
import { buildBrCode } from "./br-code.js";
import { renderQrCodeDataUri } from "./qr-code.js";
import {
  PixWebhookAuthError,
  type CreatePixChargeParams,
  type PixChargeStatus,
  type PixProvider,
  type PixProviderCharge,
  type PixProviderStatus,
  type PixWebhookEvent,
} from "./types.js";

export interface MockPixProviderOptions {
  /** Shared secret used to sign/verify webhook deliveries. */
  webhookSecret: string;
  /** Default charge lifetime in seconds. */
  ttlSeconds?: number;
  /** Pix key advertised in the generated BR Code. */
  pixKey?: string;
  merchantName?: string;
  merchantCity?: string;
  /** Allowed clock skew for webhook timestamps, in seconds. */
  webhookToleranceSeconds?: number;
}

interface StoredCharge {
  externalId: string;
  reference: string;
  amountCents: number;
  status: PixChargeStatus;
  pixCopyPaste: string;
  expiresAt: number;
  paidAt: number | null;
}

export class MockPixProvider implements PixProvider {
  readonly name = "mock";

  private readonly webhookSecret: string;
  private readonly ttlSeconds: number;
  private readonly pixKey: string;
  private readonly merchantName: string;
  private readonly merchantCity: string;
  private readonly toleranceSeconds: number;
  private readonly charges = new Map<string, StoredCharge>();
  private seq = 0;

  constructor(options: MockPixProviderOptions) {
    this.webhookSecret = options.webhookSecret;
    this.ttlSeconds = options.ttlSeconds ?? 1800;
    this.pixKey = options.pixKey ?? "pagamentos@automaton.local";
    this.merchantName = options.merchantName ?? "AUTOMATON";
    this.merchantCity = options.merchantCity ?? "SAO PAULO";
    this.toleranceSeconds = options.webhookToleranceSeconds ?? 300;
  }

  async createCharge(params: CreatePixChargeParams): Promise<PixProviderCharge> {
    if (!Number.isInteger(params.amountCents) || params.amountCents <= 0) {
      throw new Error("amountCents must be a positive integer");
    }

    this.seq += 1;
    const externalId = `mock_${Date.now().toString(36)}_${this.seq}`;
    const expiresAt = Date.now() + this.ttlSeconds * 1000;

    const pixCopyPaste = buildBrCode({
      key: this.pixKey,
      amountCents: params.amountCents,
      merchantName: this.merchantName,
      merchantCity: this.merchantCity,
      txid: params.reference.replace(/[^A-Za-z0-9]/g, "").slice(0, 25) || "AUTOMATON",
      description: params.description,
    });

    const stored: StoredCharge = {
      externalId,
      reference: params.reference,
      amountCents: params.amountCents,
      status: "PENDING",
      pixCopyPaste,
      expiresAt,
      paidAt: null,
    };
    this.charges.set(externalId, stored);

    return {
      externalId,
      amountCents: params.amountCents,
      status: "PENDING",
      pixCopyPaste,
      qrCode: await renderQrCodeDataUri(pixCopyPaste),
      expiresAt: new Date(expiresAt).toISOString(),
      paidAt: null,
    };
  }

  async getChargeStatus(externalId: string): Promise<PixProviderStatus> {
    const charge = this.requireCharge(externalId);
    this.maybeExpire(charge);

    return {
      externalId: charge.externalId,
      amountCents: charge.amountCents,
      status: charge.status,
      paidAt: charge.paidAt ? new Date(charge.paidAt).toISOString() : null,
    };
  }

  async handleWebhook(
    payload: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<PixWebhookEvent> {
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    const event = this.verifySignature(body, headers);

    const charge = this.requireCharge(event.externalId);
    this.maybeExpire(charge);

    if (charge.status !== "PAID" && event.status !== "PAID") {
      // Non-payment notifications (e.g. EXPIRED) are forwarded as-is.
      charge.status = event.status;
    }

    if (event.amountCents !== charge.amountCents) {
      throw new Error(
        `Webhook amount mismatch: received ${event.amountCents}, expected ${charge.amountCents}`,
      );
    }

    // Redeliveries are returned as-is: replay/duplicate protection is keyed
    // on the event id by PixPaymentService, which acknowledges them as
    // duplicates without applying any side effect twice.
    return event;
  }

  // ─── Development / test helpers ────────────────────────────────

  /**
   * Mark a charge as paid locally. The corresponding webhook still has to be
   * delivered through `buildSignedWebhook()` for the balance to move.
   */
  simulatePayment(externalId: string): StoredChargeSnapshot {
    const charge = this.requireCharge(externalId);
    charge.status = "PAID";
    charge.paidAt = Date.now();
    return snapshot(charge);
  }

  /** Force a charge into the EXPIRED state. */
  expireCharge(externalId: string): StoredChargeSnapshot {
    const charge = this.requireCharge(externalId);
    charge.status = "EXPIRED";
    charge.expiresAt = Date.now() - 1;
    return snapshot(charge);
  }

  /** Cancel a pending charge. */
  cancelCharge(externalId: string): StoredChargeSnapshot {
    const charge = this.requireCharge(externalId);
    if (charge.status === "PAID") {
      throw new Error("Cannot cancel a paid charge");
    }
    charge.status = "CANCELLED";
    return snapshot(charge);
  }

  getCharge(externalId: string): StoredChargeSnapshot | null {
    const charge = this.charges.get(externalId);
    if (!charge) return null;
    this.maybeExpire(charge);
    return snapshot(charge);
  }

  /**
   * Build an authenticated webhook delivery for a charge. Returns the raw
   * body plus the headers a real gateway would send.
   */
  buildSignedWebhook(
    externalId: string,
    options: { eventId?: string; amountCents?: number } = {},
  ): { body: string; headers: Record<string, string> } {
    const charge = this.requireCharge(externalId);
    const amountCents = options.amountCents ?? charge.amountCents;
    const paidAt =
      charge.paidAt != null ? new Date(charge.paidAt).toISOString() : null;

    const body = JSON.stringify({
      eventId: options.eventId ?? `evt_${crypto.randomUUID()}`,
      externalId: charge.externalId,
      status: charge.status,
      amountCents,
      paidAt,
      timestamp: new Date().toISOString(),
    });

    return {
      body,
      headers: {
        "content-type": "application/json",
        "x-pix-signature": this.sign(body),
        "x-pix-timestamp": String(Math.floor(Date.now() / 1000)),
      },
    };
  }

  sign(body: string): string {
    return crypto.createHmac("sha256", this.webhookSecret).update(body).digest("hex");
  }

  // ─── internals ─────────────────────────────────────────────────

  private verifySignature(
    body: string,
    headers: Record<string, string | string[] | undefined>,
  ): PixWebhookEvent {
    const signature = readHeader(headers, "x-pix-signature");
    if (!signature) {
      throw new PixWebhookAuthError("Missing webhook signature");
    }

    const expected = this.sign(body);
    const a = Buffer.from(signature, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new PixWebhookAuthError("Invalid webhook signature");
    }

    const timestampHeader = readHeader(headers, "x-pix-timestamp");
    if (!timestampHeader) {
      throw new PixWebhookAuthError("Missing webhook timestamp");
    }
    const timestamp = Number(timestampHeader);
    if (!Number.isFinite(timestamp)) {
      throw new PixWebhookAuthError("Invalid webhook timestamp");
    }
    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
    if (ageSeconds > this.toleranceSeconds) {
      throw new PixWebhookAuthError(
        "Webhook timestamp outside of the accepted window",
      );
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new PixWebhookAuthError("Malformed webhook payload", 400);
    }

    const eventId = typeof parsed.eventId === "string" ? parsed.eventId : null;
    const externalId = typeof parsed.externalId === "string" ? parsed.externalId : null;
    const status = typeof parsed.status === "string" ? parsed.status : null;
    const amountCents = parsed.amountCents;

    if (!eventId || !externalId || !status || !Number.isInteger(amountCents)) {
      throw new PixWebhookAuthError("Malformed webhook payload", 400);
    }
    if (!["PENDING", "PAID", "EXPIRED", "CANCELLED", "FAILED"].includes(status)) {
      throw new PixWebhookAuthError(`Unknown webhook status: ${status}`, 400);
    }

    return {
      eventId,
      externalId,
      status: status as PixChargeStatus,
      amountCents: amountCents as number,
      paidAt: typeof parsed.paidAt === "string" ? parsed.paidAt : null,
    };
  }

  private requireCharge(externalId: string): StoredCharge {
    const charge = this.charges.get(externalId);
    if (!charge) {
      throw new Error(`Unknown Pix charge: ${externalId}`);
    }
    return charge;
  }

  private maybeExpire(charge: StoredCharge): void {
    if (charge.status === "PENDING" && Date.now() > charge.expiresAt) {
      charge.status = "EXPIRED";
    }
  }
}

export interface StoredChargeSnapshot {
  externalId: string;
  reference: string;
  amountCents: number;
  status: PixChargeStatus;
  pixCopyPaste: string;
  expiresAt: string;
  paidAt: string | null;
}

function snapshot(charge: StoredCharge): StoredChargeSnapshot {
  return {
    externalId: charge.externalId,
    reference: charge.reference,
    amountCents: charge.amountCents,
    status: charge.status,
    pixCopyPaste: charge.pixCopyPaste,
    expiresAt: new Date(charge.expiresAt).toISOString(),
    paidAt: charge.paidAt ? new Date(charge.paidAt).toISOString() : null,
  };
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function createMockPixProvider(
  options: MockPixProviderOptions,
): MockPixProvider {
  return new MockPixProvider(options);
}
