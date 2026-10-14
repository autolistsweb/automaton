/**
 * PixPaymentService tests — src/payments/pix-payment-service.ts
 *
 * Covers charge creation, status transitions, signed webhook processing
 * (idempotency, replay and tamper rejection), balance/ledger effects and the
 * credit-purchase ledger entry.
 *
 * The contract gaps these tests used to document (`it.fails`) are fixed in
 * `src/payments/*`: spec-valid BR Code CRC, exactly-once credit after a status
 * poll, and duplicate redeliveries resolved as duplicates.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import v8 from "node:v8";
import vm from "node:vm";
import { createTestDb, createTestIdentity } from "./mocks.js";
import { MockPixProvider } from "../payments/mock-provider.js";
import {
  PixPaymentService,
  PixWebhookError,
} from "../payments/pix-payment-service.js";
import { createPixPaymentService } from "../payments/index.js";
import { MAX_CHARGE_CENTS, MIN_CHARGE_CENTS, formatBRL } from "../payments/money.js";
import { crc16CcittFalse } from "../payments/br-code.js";
import { getBalanceCents, listFinancialTransactions } from "../state/database.js";
import { purchaseCredits } from "../conway/topup.js";
import type { AutomatonDatabase, ConwayClient } from "../types.js";

const WEBHOOK_SECRET = "unit-test-pix-webhook-secret";

let db: AutomatonDatabase;
let provider: MockPixProvider;
let service: PixPaymentService;
let userId: string;

/** Intl may separate "R$" from the digits with NBSP / narrow NBSP. */
function brl(label: string): string {
  return label.replace(/[\u00A0\u202F]/g, " ");
}

function forceGc(): void {
  try {
    v8.setFlagsFromString("--expose_gc");
    const gc = vm.runInNewContext("gc") as () => void;
    v8.setFlagsFromString("--no-expose_gc");
    gc();
  } catch {
    // ignore — GC simply unavailable
  }
}

function eventBody(fields: {
  eventId: string;
  externalId: string;
  status: string;
  amountCents: number;
  paidAt?: string | null;
}): string {
  return JSON.stringify({
    eventId: fields.eventId,
    externalId: fields.externalId,
    status: fields.status,
    amountCents: fields.amountCents,
    paidAt: fields.paidAt ?? null,
    timestamp: new Date().toISOString(),
  });
}

/** Build a signed delivery for an existing provider charge. */
function delivery(
  p: MockPixProvider,
  externalId: string,
  eventId?: string,
): { body: string; payload: unknown; headers: Record<string, string> } {
  const signed = p.buildSignedWebhook(externalId, eventId ? { eventId } : {});
  return {
    body: signed.body,
    payload: JSON.parse(signed.body) as unknown,
    headers: signed.headers,
  };
}

/** Build a signed delivery from an arbitrary raw body. */
function customDelivery(
  p: MockPixProvider,
  body: string,
  timestampSeconds = Math.floor(Date.now() / 1000),
): { payload: unknown; headers: Record<string, string> } {
  return {
    payload: JSON.parse(body) as unknown,
    headers: {
      "content-type": "application/json",
      "x-pix-signature": p.sign(body),
      "x-pix-timestamp": String(timestampSeconds),
    },
  };
}

async function createPendingCharge(amountCents: number, description?: string) {
  const { charge, reused } = await service.createCharge({
    userId,
    amountCents,
    description,
  });
  expect(reused).toBe(false);
  return charge;
}

async function createPaidCharge(amountCents: number) {
  const charge = await createPendingCharge(amountCents);
  provider.simulatePayment(charge.externalId);
  return charge;
}

beforeEach(() => {
  db = createTestDb();
  provider = new MockPixProvider({ webhookSecret: WEBHOOK_SECRET });
  service = new PixPaymentService({ db: db.raw, provider });
  userId = createTestIdentity().accountId;
});

afterEach(() => {
  db.close();
  forceGc();
});

afterAll(() => {
  forceGc();
});

describe("PixPaymentService.createCharge", () => {
  it("creates a PENDING charge with amount, expiry, BR Code and QR data", async () => {
    const charge = await createPendingCharge(1990, "Adição de saldo");

    expect(charge.id).toHaveLength(26);
    expect(charge.userId).toBe(userId);
    expect(charge.provider).toBe("mock");
    expect(charge.amountCents).toBe(1990);
    expect(charge.currency).toBe("BRL");
    expect(charge.status).toBe("PENDING");
    expect(charge.paidAt).toBeNull();
    expect(charge.description).toBe("Adição de saldo");
    expect(charge.externalId).toMatch(/^mock_/);
    expect(charge.createdAt).toBeTruthy();

    expect(charge.expiresAt).toBeTruthy();
    expect(Date.parse(charge.expiresAt as string)).toBeGreaterThan(Date.now());

    const copyPaste = charge.pixCopyPaste as string;
    expect(copyPaste).toMatch(/^000201/);
    expect(copyPaste).toContain("br.gov.bcb.pix");
    expect(copyPaste).toContain("540519.90");
    expect(copyPaste).toMatch(/6304[0-9A-F]{4}$/);

    expect(charge.qrCode).toMatch(/^data:image\/svg\+xml/);

    expect(service.getBalanceCents(userId)).toBe(0);
    expect(getBalanceCents(db.raw, userId)).toBe(0);
    expect(service.listTransactions(userId)).toHaveLength(0);
  });

  // The EMV/Pix CRC must be computed over the whole payload including the
  // literal "6304" header of the CRC field itself (value excluded).
  it("embeds a spec-valid CRC computed over the payload including 6304", async () => {
    const charge = await createPendingCharge(1990, "Adição de saldo");
    const copyPaste = charge.pixCopyPaste as string;

    const crc = copyPaste.slice(-4);
    const payloadWithoutCrc = copyPaste.slice(0, -4);

    expect(copyPaste.slice(-8, -4)).toBe("6304");
    expect(crc).toMatch(/^[0-9A-F]{4}$/);
    expect(crc16CcittFalse(payloadWithoutCrc)).toBe(crc);
  });

  it("rejects amounts below the minimum charge", async () => {
    await expect(
      service.createCharge({ userId, amountCents: MIN_CHARGE_CENTS - 1 }),
    ).rejects.toThrow(/Minimum amount/);
    expect(service.listCharges(userId)).toHaveLength(0);
  });

  it("rejects amounts above the maximum charge", async () => {
    await expect(
      service.createCharge({ userId, amountCents: MAX_CHARGE_CENTS + 1 }),
    ).rejects.toThrow(/Maximum amount/);
    expect(service.listCharges(userId)).toHaveLength(0);
  });

  it("rejects non-integer amounts and a missing user", async () => {
    await expect(
      service.createCharge({ userId, amountCents: 1990.5 }),
    ).rejects.toThrow(/integer/);
    await expect(
      service.createCharge({ userId: "", amountCents: 1990 }),
    ).rejects.toThrow(/userId is required/);
    expect(service.listCharges(userId)).toHaveLength(0);
  });

  it("reuses an identical pending charge instead of duplicating it", async () => {
    const first = await createPendingCharge(2500, "Recarga");
    const second = await service.createCharge({
      userId,
      amountCents: 2500,
      description: "Recarga",
    });

    expect(second.reused).toBe(true);
    expect(second.charge.id).toBe(first.id);
    expect(second.charge.externalId).toBe(first.externalId);
    expect(service.listCharges(userId)).toHaveLength(1);
  });

  it("generates distinct charge ids per charge", async () => {
    const otherUser = "acct_abcdefabcdefabcd1234";
    const a = await createPendingCharge(1000);
    const b = await createPendingCharge(2500);
    const c = await service.createCharge({ userId: otherUser, amountCents: 1000 });

    expect(new Set([a.id, b.id, c.charge.id]).size).toBe(3);
    expect(new Set([a.externalId, b.externalId, c.charge.externalId]).size).toBe(3);
    expect(c.reused).toBe(false);
    expect(service.listCharges(userId)).toHaveLength(2);
    expect(service.listCharges(otherUser)).toHaveLength(1);
  });
});

describe("PixPaymentService.getStatus", () => {
  it("returns the pending state before any confirmation", async () => {
    const charge = await createPendingCharge(5000);
    const status = await service.getStatus(charge.id);

    expect(status.status).toBe("PENDING");
    expect(status.paidAt).toBeNull();
    expect(service.getBalanceCents(userId)).toBe(0);
  });

  it("mirrors a provider-side PAID state without moving money", async () => {
    const charge = await createPendingCharge(5000);
    provider.simulatePayment(charge.externalId);

    const status = await service.getStatus(charge.id);

    expect(status.status).toBe("PAID");
    expect(status.paidAt).toBeTruthy();
    expect(getBalanceCents(db.raw, userId)).toBe(0);
    expect(service.listTransactions(userId)).toHaveLength(0);
  });

  it("mirrors a provider-side EXPIRED state", async () => {
    const charge = await createPendingCharge(5000);
    provider.expireCharge(charge.externalId);

    const status = await service.getStatus(charge.id);

    expect(status.status).toBe("EXPIRED");
    expect(getBalanceCents(db.raw, userId)).toBe(0);
  });

  it("mirrors a provider-side CANCELLED state", async () => {
    const charge = await createPendingCharge(5000);
    provider.cancelCharge(charge.externalId);

    const status = await service.getStatus(charge.id);

    expect(status.status).toBe("CANCELLED");
    expect(getBalanceCents(db.raw, userId)).toBe(0);
  });

  it("surfaces FAILED after a failed webhook event", async () => {
    const charge = await createPendingCharge(5000);
    const body = eventBody({
      eventId: "evt_failed_1",
      externalId: charge.externalId,
      status: "FAILED",
      amountCents: 5000,
    });
    const deliveryAttempt = customDelivery(provider, body);
    await service.handleWebhook(deliveryAttempt.payload, deliveryAttempt.headers);

    const status = await service.getStatus(charge.id);

    expect(status.status).toBe("FAILED");
    expect(getBalanceCents(db.raw, userId)).toBe(0);
    expect(service.listTransactions(userId)).toHaveLength(0);
  });

  it("rejects unknown charge ids", async () => {
    await expect(service.getStatus("charge_does_not_exist")).rejects.toThrow(
      /Unknown Pix charge/,
    );
  });
});

describe("PixPaymentService.handleWebhook", () => {
  it("marks the charge PAID, credits the balance once and records the ledger row", async () => {
    const charge = await createPaidCharge(5000);
    const d = delivery(provider, charge.externalId);

    const result = await service.handleWebhook(d.payload, d.headers);

    expect(result).toMatchObject({
      ok: true,
      duplicate: false,
      chargeId: charge.id,
      balanceCents: 5000,
    });
    expect(service.getBalanceCents(userId)).toBe(5000);
    expect(getBalanceCents(db.raw, userId)).toBe(5000);
    expect(brl(service.getBalanceLabel(userId))).toBe("R$ 50,00");

    const local = service.getCharge(charge.id);
    expect(local?.status).toBe("PAID");
    expect(local?.paidAt).toBeTruthy();

    const txns = service.listTransactions(userId);
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({
      userId,
      type: "pix_deposit",
      amountCents: 5000,
      balanceAfterCents: 5000,
      currency: "BRL",
      paymentMethod: "PIX",
      status: "COMPLETED",
      referenceId: charge.id,
    });
    expect(txns[0].description).toContain(formatBRL(5000));
    expect(Number.isInteger(txns[0].amountCents)).toBe(true);
  });

  it("does not credit twice when the same charge is confirmed by a second event", async () => {
    const charge = await createPaidCharge(5000);

    const first = delivery(provider, charge.externalId, "evt_first");
    await service.handleWebhook(first.payload, first.headers);

    const second = delivery(provider, charge.externalId, "evt_replay");
    const result = await service.handleWebhook(second.payload, second.headers);

    expect(result).toMatchObject({ ok: true, duplicate: true, balanceCents: 5000 });
    expect(getBalanceCents(db.raw, userId)).toBe(5000);
    expect(service.listTransactions(userId)).toHaveLength(1);
  });

  it("never credits twice when the identical delivery is retried", async () => {
    const charge = await createPaidCharge(5000);
    const d = delivery(provider, charge.externalId);

    const first = await service.handleWebhook(d.payload, d.headers);
    expect(first.duplicate).toBe(false);

    await service
      .handleWebhook(JSON.parse(d.body) as unknown, d.headers)
      .then(
        (res) => res,
        () => undefined,
      );

    expect(getBalanceCents(db.raw, userId)).toBe(5000);
    expect(service.listTransactions(userId)).toHaveLength(1);
    expect(service.getCharge(charge.id)?.status).toBe("PAID");
  });

  // An identical redelivery must resolve as a duplicate: the provider returns
  // the event again and the service dedup (pix-payment-service.ts) answers
  // { ok: true, duplicate: true } instead of rejecting.
  it("resolves an identical redelivery as a duplicate instead of rejecting", async () => {
    const charge = await createPaidCharge(5000);
    const d = delivery(provider, charge.externalId);

    await service.handleWebhook(d.payload, d.headers);
    const retry = await service.handleWebhook(JSON.parse(d.body) as unknown, d.headers);

    expect(retry).toMatchObject({ ok: true, duplicate: true, balanceCents: 5000 });
  });

  it("rejects a signature made with a different webhook secret and credits nothing", async () => {
    const charge = await createPaidCharge(5000);
    const d = delivery(provider, charge.externalId);
    const wrongSecret = new MockPixProvider({ webhookSecret: "wrong-secret" });

    await expect(
      service.handleWebhook(d.payload, {
        ...d.headers,
        "x-pix-signature": wrongSecret.sign(d.body),
      }),
    ).rejects.toThrow(/Invalid webhook signature/);

    expect(getBalanceCents(db.raw, userId)).toBe(0);
    expect(service.getCharge(charge.id)?.status).toBe("PENDING");
    expect(service.listTransactions(userId)).toHaveLength(0);
  });

  it("rejects a delivery without a signature and credits nothing", async () => {
    const charge = await createPaidCharge(5000);
    const d = delivery(provider, charge.externalId);
    const headers = { ...d.headers } as Record<string, string | undefined>;
    delete headers["x-pix-signature"];

    await expect(service.handleWebhook(d.payload, headers)).rejects.toThrow(
      /Missing webhook signature/,
    );

    expect(getBalanceCents(db.raw, userId)).toBe(0);
    expect(service.getCharge(charge.id)?.status).toBe("PENDING");
    expect(service.listTransactions(userId)).toHaveLength(0);
  });

  it("rejects a delivery outside the timestamp replay window", async () => {
    const charge = await createPaidCharge(5000);
    const d = delivery(provider, charge.externalId);

    await expect(
      service.handleWebhook(d.payload, {
        ...d.headers,
        "x-pix-timestamp": String(Math.floor(Date.now() / 1000) - 1000),
      }),
    ).rejects.toThrow(/outside of the accepted window/);

    expect(getBalanceCents(db.raw, userId)).toBe(0);
    expect(service.listTransactions(userId)).toHaveLength(0);
  });

  it("rejects a webhook for a charge that is unknown locally with 404", async () => {
    const orphan = await provider.createCharge({
      reference: "pix_orphan_charge",
      amountCents: 1000,
    });
    const d = provider.buildSignedWebhook(orphan.externalId);

    const err = await service
      .handleWebhook(JSON.parse(d.body) as unknown, d.headers)
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(PixWebhookError);
    expect((err as PixWebhookError).statusCode).toBe(404);
    expect(getBalanceCents(db.raw, userId)).toBe(0);
    expect(service.listTransactions(userId)).toHaveLength(0);
  });

  it("rejects a webhook for an external id the provider does not know", async () => {
    const body = eventBody({
      eventId: "evt_ghost",
      externalId: "mock_never_created",
      status: "PAID",
      amountCents: 1000,
      paidAt: new Date().toISOString(),
    });
    const d = customDelivery(provider, body);

    await expect(service.handleWebhook(d.payload, d.headers)).rejects.toThrow(
      /Unknown Pix charge/,
    );
    expect(getBalanceCents(db.raw, userId)).toBe(0);
  });

  it("rejects a correctly signed webhook with a tampered amount", async () => {
    const charge = await createPendingCharge(5000);
    const body = eventBody({
      eventId: "evt_tampered",
      externalId: charge.externalId,
      status: "PAID",
      amountCents: 5001,
      paidAt: new Date().toISOString(),
    });
    const d = customDelivery(provider, body);

    await expect(service.handleWebhook(d.payload, d.headers)).rejects.toThrow(
      /amount mismatch/i,
    );

    expect(getBalanceCents(db.raw, userId)).toBe(0);
    expect(service.getCharge(charge.id)?.status).toBe("PENDING");
    expect(service.listTransactions(userId)).toHaveLength(0);
  });

  it("applies an EXPIRED webhook without crediting the balance", async () => {
    const charge = await createPendingCharge(5000);
    const body = eventBody({
      eventId: "evt_expired",
      externalId: charge.externalId,
      status: "EXPIRED",
      amountCents: 5000,
    });
    const d = customDelivery(provider, body);

    const result = await service.handleWebhook(d.payload, d.headers);

    expect(result.ok).toBe(true);
    expect(service.getCharge(charge.id)?.status).toBe("EXPIRED");
    expect(getBalanceCents(db.raw, userId)).toBe(0);
    expect(service.listTransactions(userId)).toHaveLength(0);
  });

  it("ignores an out-of-order CANCELLED event that arrives after payment", async () => {
    const charge = await createPaidCharge(5000);
    const paid = delivery(provider, charge.externalId, "evt_paid");
    await service.handleWebhook(paid.payload, paid.headers);

    const cancelBody = eventBody({
      eventId: "evt_cancel_late",
      externalId: charge.externalId,
      status: "CANCELLED",
      amountCents: 5000,
    });
    const d = customDelivery(provider, cancelBody);
    const result = await service.handleWebhook(d.payload, d.headers);

    expect(result).toMatchObject({ ok: true, balanceCents: 5000 });
    expect(service.getCharge(charge.id)?.status).toBe("PAID");
    expect(getBalanceCents(db.raw, userId)).toBe(5000);
    expect(service.listTransactions(userId)).toHaveLength(1);
  });

  it("ignores an out-of-order PENDING event that arrives after payment", async () => {
    const charge = await createPaidCharge(5000);
    const paid = delivery(provider, charge.externalId, "evt_paid");
    await service.handleWebhook(paid.payload, paid.headers);

    const pendingBody = eventBody({
      eventId: "evt_pending_late",
      externalId: charge.externalId,
      status: "PENDING",
      amountCents: 5000,
    });
    const d = customDelivery(provider, pendingBody);
    const result = await service.handleWebhook(d.payload, d.headers);

    expect(result).toMatchObject({ ok: true, balanceCents: 5000 });
    expect(service.getCharge(charge.id)?.status).toBe("PAID");
    expect(getBalanceCents(db.raw, userId)).toBe(5000);
    expect(service.listTransactions(userId)).toHaveLength(1);
  });

  // A valid PAID webhook must credit the balance exactly once even when a
  // status poll mirrored PAID first: idempotency is keyed on the charge's
  // ledger row, not on the previous status.
  it("credits the balance when the PAID webhook follows a status poll", async () => {
    const charge = await createPendingCharge(5000);
    provider.simulatePayment(charge.externalId);
    await service.getStatus(charge.id);

    const d = delivery(provider, charge.externalId, "evt_after_poll");
    const result = await service.handleWebhook(d.payload, d.headers);

    expect(result).toMatchObject({
      ok: true,
      duplicate: false,
      chargeId: charge.id,
      balanceCents: 5000,
    });
    expect(getBalanceCents(db.raw, userId)).toBe(5000);
    expect(service.listTransactions(userId)).toHaveLength(1);
    expect(service.getCharge(charge.id)?.status).toBe("PAID");

    const again = delivery(provider, charge.externalId, "evt_after_poll_retry");
    const retry = await service.handleWebhook(again.payload, again.headers);

    expect(retry).toMatchObject({ ok: true, duplicate: true, balanceCents: 5000 });
    expect(getBalanceCents(db.raw, userId)).toBe(5000);
    expect(service.listTransactions(userId)).toHaveLength(1);
  });
});

describe("PixPaymentService listings", () => {
  it("returns charge and statement rows with integer centavos", async () => {
    await createPendingCharge(1000, "Recarga R$ 10,00");
    await createPendingCharge(2500, "Recarga R$ 25,00");

    const charges = service.listCharges(userId);
    expect(charges).toHaveLength(2);
    for (const charge of charges) {
      expect(Number.isInteger(charge.amountCents)).toBe(true);
      expect(charge.currency).toBe("BRL");
      expect(charge.status).toBe("PENDING");
      expect(typeof charge.pixCopyPaste).toBe("string");
      expect(typeof charge.qrCode).toBe("string");
      expect(typeof charge.description).toBe("string");
      expect(charge.createdAt).toBeTruthy();
      expect(charge.expiresAt).toBeTruthy();
    }
    expect(charges.map((c) => c.amountCents).sort((a, b) => a - b)).toEqual([1000, 2500]);
    expect(service.listTransactions(userId)).toEqual([]);
    expect(service.listCharges("acct_00000000000000000000")).toEqual([]);
  });

  it("returns the deposit row only after a confirmed payment", async () => {
    const charge = await createPaidCharge(1000);
    expect(service.listTransactions(userId)).toHaveLength(0);

    const d = delivery(provider, charge.externalId);
    await service.handleWebhook(d.payload, d.headers);

    const txns = service.listTransactions(userId, 10);
    expect(txns).toHaveLength(1);
    expect(txns[0].type).toBe("pix_deposit");
    expect(txns[0].balanceAfterCents).toBe(1000);
    expect(brl(txns[0].description)).toBe(`Pix recebido — ${brl(formatBRL(1000))}`);
  });
});

describe("createPixPaymentService", () => {
  it("builds a working service from configuration", async () => {
    const configured = createPixPaymentService(db.raw, {
      PIX_PROVIDER: "mock",
      PIX_ENVIRONMENT: "test",
      PIX_WEBHOOK_SECRET: "factory-secret",
    });

    const { charge, reused } = await configured.createCharge({
      userId,
      amountCents: 1990,
    });

    expect(reused).toBe(false);
    expect(charge.status).toBe("PENDING");
    expect(charge.provider).toBe("mock");
    expect(charge.amountCents).toBe(1990);
    expect(brl(configured.getBalanceLabel(userId))).toBe("R$ 0,00");

    const signer = new MockPixProvider({ webhookSecret: "factory-secret" });
    const body = eventBody({
      eventId: "evt_factory",
      externalId: charge.externalId,
      status: "PAID",
      amountCents: 1990,
      paidAt: new Date().toISOString(),
    });
    const d = customDelivery(signer, body);
    const result = await configured.handleWebhook(d.payload, d.headers);

    expect(result.balanceCents).toBe(1990);
    expect(getBalanceCents(db.raw, userId)).toBe(1990);
  });
});

describe("credit purchase ledger", () => {
  it("refunds the balance and records a FAILED entry when the purchase fails", async () => {
    db.creditBalance(userId, 10_000);
    const failingConway = {
      purchaseCredits: async () => {
        throw new Error("credits gateway unavailable");
      },
    } as unknown as ConwayClient;

    const result = await purchaseCredits({
      db: db.raw,
      userId,
      amountCents: 1000,
      conway: failingConway,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("credits gateway unavailable");
    expect(result.balanceCents).toBe(10_000);
    expect(getBalanceCents(db.raw, userId)).toBe(10_000);

    const txns = listFinancialTransactions(db.raw, userId);
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({
      userId,
      type: "credit_purchase",
      status: "FAILED",
      amountCents: 0,
      balanceAfterCents: 10_000,
      currency: "BRL",
      paymentMethod: "PIX",
    });
    expect(txns[0].referenceId).toMatch(/^crd_/);
    expect(Number.isInteger(txns[0].amountCents)).toBe(true);
  });

  it("debits the balance and records a COMPLETED entry on success", async () => {
    db.creditBalance(userId, 10_000);
    const conway = {
      purchaseCredits: async () => ({ creditsCentsAdded: 1000 }),
    } as unknown as ConwayClient;

    const result = await purchaseCredits({
      db: db.raw,
      userId,
      amountCents: 1000,
      conway,
    });

    expect(result.success).toBe(true);
    expect(result.balanceCents).toBe(9000);
    expect(getBalanceCents(db.raw, userId)).toBe(9000);

    const txns = listFinancialTransactions(db.raw, userId);
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({
      type: "credit_purchase",
      status: "COMPLETED",
      amountCents: -1000,
      balanceAfterCents: 9000,
      currency: "BRL",
    });
  });
});
