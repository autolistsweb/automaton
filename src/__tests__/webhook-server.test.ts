/**
 * Pix webhook server tests — src/payments/webhook-server.ts
 *
 * Real HTTP round-trips against `startPixWebhookServer` bound to an
 * ephemeral port on the loopback interface.
 *
 * Signature/auth failures answer 401, malformed payloads 400, oversized
 * bodies 413 and identical redeliveries 200 with `duplicate: true` — the
 * contract tests for those used to be declared `it.fails`.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import v8 from "node:v8";
import vm from "node:vm";
import { createTestDb, createTestIdentity } from "./mocks.js";
import { MockPixProvider } from "../payments/mock-provider.js";
import { PixPaymentService } from "../payments/pix-payment-service.js";
import {
  PIX_WEBHOOK_PATH,
  startPixWebhookServer,
} from "../payments/webhook-server.js";
import type { WebhookServer } from "../payments/webhook-server.js";
import { getBalanceCents } from "../state/database.js";
import type { AutomatonDatabase } from "../types.js";

const WEBHOOK_SECRET = "server-test-pix-webhook-secret";

let db: AutomatonDatabase;
let provider: MockPixProvider;
let service: PixPaymentService;
let server: WebhookServer | undefined;
let userId: string;

async function createPaidCharge(amountCents: number) {
  const { charge } = await service.createCharge({ userId, amountCents });
  provider.simulatePayment(charge.externalId);
  return charge;
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

beforeEach(async () => {
  db = createTestDb();
  provider = new MockPixProvider({ webhookSecret: WEBHOOK_SECRET });
  service = new PixPaymentService({ db: db.raw, provider });
  server = await startPixWebhookServer({
    service,
    port: 0,
    host: "127.0.0.1",
  });
  userId = createTestIdentity().accountId;
});

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  db.close();
  forceGc();
});

afterAll(() => {
  forceGc();
});

describe("startPixWebhookServer", () => {
  it("binds an ephemeral loopback port and exposes the webhook url", () => {
    expect(PIX_WEBHOOK_PATH).toBe("/api/payments/pix/webhook");
    expect(server?.port).toBeGreaterThan(0);
    expect(server?.url).toBe(`http://127.0.0.1:${server?.port}${PIX_WEBHOOK_PATH}`);
  });

  it("answers 405 to GET on the webhook path", async () => {
    const res = await fetch(server!.url);
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "method_not_allowed" });
  });

  it("answers 404 to methods other than POST/GET/HEAD", async () => {
    const res = await fetch(server!.url, { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("answers 404 to an unknown path", async () => {
    const res = await fetch(`http://127.0.0.1:${server!.port}/api/payments/pix/other`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("answers 400 when the body is not valid JSON", async () => {
    const res = await fetch(server!.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
    expect(getBalanceCents(db.raw, userId)).toBe(0);
  });

  it("accepts a valid signed webhook with 200 and lets the service handle it", async () => {
    const charge = await createPaidCharge(1990);
    const signed = provider.buildSignedWebhook(charge.externalId);

    const res = await fetch(server!.url, {
      method: "POST",
      headers: signed.headers,
      body: signed.body,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      duplicate: false,
      charge_id: charge.id,
      balance_cents: 1990,
    });
    expect(getBalanceCents(db.raw, userId)).toBe(1990);
    expect(service.getCharge(charge.id)?.status).toBe("PAID");
    expect(service.listTransactions(userId)).toHaveLength(1);
  });

  it("answers 200 with duplicate=true when another event confirms the same charge", async () => {
    const charge = await createPaidCharge(1990);

    const first = provider.buildSignedWebhook(charge.externalId, { eventId: "evt_one" });
    const res1 = await fetch(server!.url, {
      method: "POST",
      headers: first.headers,
      body: first.body,
    });
    expect(res1.status).toBe(200);
    expect((await res1.json()).duplicate).toBe(false);

    const second = provider.buildSignedWebhook(charge.externalId, { eventId: "evt_two" });
    const res2 = await fetch(server!.url, {
      method: "POST",
      headers: second.headers,
      body: second.body,
    });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({
      ok: true,
      duplicate: true,
      charge_id: charge.id,
      balance_cents: 1990,
    });
    expect(getBalanceCents(db.raw, userId)).toBe(1990);
    expect(service.listTransactions(userId)).toHaveLength(1);
  });

  it("never mutates the database when the webhook secret is wrong", async () => {
    const charge = await createPaidCharge(1990);
    const signed = provider.buildSignedWebhook(charge.externalId);
    const wrongSecret = new MockPixProvider({ webhookSecret: "another-secret" });

    const res = await fetch(server!.url, {
      method: "POST",
      headers: { ...signed.headers, "x-pix-signature": wrongSecret.sign(signed.body) },
      body: signed.body,
    });

    expect(res.status).toBe(401);
    expect(getBalanceCents(db.raw, userId)).toBe(0);
    expect(service.getCharge(charge.id)?.status).toBe("PENDING");
    expect(service.listTransactions(userId)).toHaveLength(0);
  });

  it("answers 401 when the signature header is missing", async () => {
    const charge = await createPaidCharge(1990);
    const signed = provider.buildSignedWebhook(charge.externalId);

    const res = await fetch(server!.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: signed.body,
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Missing webhook signature" });
    expect(getBalanceCents(db.raw, userId)).toBe(0);
  });

  it("answers 401 when the signature is invalid", async () => {
    const charge = await createPaidCharge(1990);
    const signed = provider.buildSignedWebhook(charge.externalId);
    const wrongSecret = new MockPixProvider({ webhookSecret: "another-secret" });

    const res = await fetch(server!.url, {
      method: "POST",
      headers: { ...signed.headers, "x-pix-signature": wrongSecret.sign(signed.body) },
      body: signed.body,
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid webhook signature" });
    expect(getBalanceCents(db.raw, userId)).toBe(0);
    expect(service.listTransactions(userId)).toHaveLength(0);
  });

  it("answers 413 when the body exceeds 64KB", async () => {
    const res = await fetch(server!.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: "x".repeat(70 * 1024) }),
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });
    expect(res.headers.get("connection")?.toLowerCase()).toBe("close");
  });

  it("answers 200 when the identical delivery is retried", async () => {
    const charge = await createPaidCharge(1990);
    const signed = provider.buildSignedWebhook(charge.externalId);

    const first = await fetch(server!.url, {
      method: "POST",
      headers: signed.headers,
      body: signed.body,
    });
    expect(first.status).toBe(200);

    const retry = await fetch(server!.url, {
      method: "POST",
      headers: signed.headers,
      body: signed.body,
    });
    expect(retry.status).toBe(200);
    expect((await retry.json()).duplicate).toBe(true);
    expect(getBalanceCents(db.raw, userId)).toBe(1990);
    expect(service.listTransactions(userId)).toHaveLength(1);
  });

  it("an oversized payload never mutates the database", async () => {
    const charge = await createPaidCharge(1990);
    const signed = provider.buildSignedWebhook(charge.externalId);
    const body = JSON.stringify({
      ...JSON.parse(signed.body),
      padding: "x".repeat(70 * 1024),
    });

    await fetch(server!.url, {
      method: "POST",
      headers: signed.headers,
      body,
    }).catch(() => undefined);

    expect(getBalanceCents(db.raw, userId)).toBe(0);
    expect(service.getCharge(charge.id)?.status).toBe("PENDING");
    expect(service.listTransactions(userId)).toHaveLength(0);
  });

  it("an unknown charge id is rejected without touching the balance", async () => {
    const charge = await createPaidCharge(1990);
    const signed = provider.buildSignedWebhook(charge.externalId);
    const body = JSON.stringify({
      ...JSON.parse(signed.body),
      externalId: "mock_never_created",
    });
    const signature = provider.sign(body);

    const res = await fetch(server!.url, {
      method: "POST",
      headers: { ...signed.headers, "x-pix-signature": signature },
      body,
    });

    expect(res.status).not.toBe(200);
    expect(getBalanceCents(db.raw, userId)).toBe(0);
    expect(service.getCharge(charge.id)?.status).toBe("PENDING");
    expect(service.listTransactions(userId)).toHaveLength(0);
  });
});
