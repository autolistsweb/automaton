/**
 * Mercado Pago Pix provider adapter.
 *
 * Uses the official Mercado Pago Payments API:
 *   POST  /v1/payments            — create a Pix charge (payment_method_id=pix)
 *   GET   /v1/payments/{id}       — authoritative charge status
 *   Webhook                       — signed with `x-signature` (HMAC-SHA256)
 *
 * The webhook handler never trusts the notification payload for money
 * movement: after the signature is verified, the payment is re-fetched from
 * the API and only that authoritative status is used.
 */

import crypto from "crypto";
import type { PixEnvironment } from "./provider.js";
import type {
  CreatePixChargeParams,
  PixProvider,
  PixProviderCharge,
  PixProviderStatus,
  PixWebhookEvent,
} from "./types.js";

export interface MercadoPagoPixProviderOptions {
  accessToken: string;
  webhookSecret: string;
  environment: PixEnvironment;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const STATUS_MAP: Record<string, PixProviderStatus["status"]> = {
  pending: "PENDING",
  in_process: "PENDING",
  authorized: "PENDING",
  approved: "PAID",
  cancelled: "CANCELLED",
  rejected: "FAILED",
  refunded: "FAILED",
  charged_back: "FAILED",
};

export class MercadoPagoPixProvider implements PixProvider {
  readonly name = "mercadopago";

  private readonly accessToken: string;
  private readonly webhookSecret: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly seenEvents = new Set<string>();

  constructor(options: MercadoPagoPixProviderOptions) {
    if (!options.accessToken) {
      throw new Error("Mercado Pago access token is required");
    }
    this.accessToken = options.accessToken;
    this.webhookSecret = options.webhookSecret;
    this.baseUrl =
      options.baseUrl ??
      (options.environment === "production"
        ? "https://api.mercadopago.com"
        : "https://api.mercadopago.com");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async createCharge(params: CreatePixChargeParams): Promise<PixProviderCharge> {
    const amount = params.amountCents / 100;

    const response = await this.request("POST", "/v1/payments", {
      headers: {
        "X-Idempotency-Key": params.reference,
      },
      body: {
        transaction_amount: amount,
        description: params.description || "Adição de saldo",
        payment_method_id: "pix",
        external_reference: params.reference,
        payer: { email: "pagador@automaton.local" },
      },
    });

    const paymentId = String(response.id ?? "");
    const qrCode =
      response.point_of_interaction?.transaction_data?.qr_code ?? null;

    if (!paymentId || !qrCode) {
      throw new Error("Mercado Pago did not return a Pix QR code");
    }

    const expiresAt = response.date_of_expiration
      ? new Date(response.date_of_expiration).toISOString()
      : new Date(Date.now() + (params.expiresInSeconds ?? 1800) * 1000).toISOString();

    return {
      externalId: paymentId,
      amountCents: Math.round(Number(response.transaction_amount) * 100),
      status: this.mapStatus(response.status),
      pixCopyPaste: qrCode,
      qrCode:
        response.point_of_interaction?.transaction_data?.qr_code_base64
          ? `data:image/png;base64,${response.point_of_interaction.transaction_data.qr_code_base64}`
          : await svgDataUri(qrCode),
      expiresAt,
      paidAt: response.date_approved
        ? new Date(response.date_approved).toISOString()
        : null,
    };
  }

  async getChargeStatus(externalId: string): Promise<PixProviderStatus> {
    const payment = await this.request("GET", `/v1/payments/${encodeURIComponent(externalId)}`);
    return {
      externalId: String(payment.id ?? externalId),
      amountCents: Math.round(Number(payment.transaction_amount ?? 0) * 100),
      status: this.mapStatus(payment.status),
      paidAt: payment.date_approved
        ? new Date(payment.date_approved).toISOString()
        : null,
    };
  }

  async handleWebhook(
    payload: unknown,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<PixWebhookEvent> {
    const signature = readHeader(headers, "x-signature") ?? "";
    const requestId = readHeader(headers, "x-request-id") ?? "";
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);

    const paymentId = extractPaymentId(payload, signature);
    if (!paymentId) {
      throw new Error("Webhook payload does not reference a payment");
    }

    verifyMpSignature({
      signature,
      requestId,
      paymentId,
      webhookSecret: this.webhookSecret,
    });

    const eventId = `${readHeader(headers, "x-request-id") ?? "mp"}:${paymentId}`;
    if (this.seenEvents.has(eventId)) {
      throw new Error(`Replayed webhook event: ${eventId}`);
    }
    this.seenEvents.add(eventId);

    // Authoritative status — the notification payload is never trusted.
    const status = await this.getChargeStatus(paymentId);

    if (!body) {
      throw new Error("Empty webhook body");
    }

    return {
      eventId,
      externalId: status.externalId,
      status: status.status,
      amountCents: status.amountCents,
      paidAt: status.paidAt,
    };
  }

  private mapStatus(status: string | undefined): PixProviderStatus["status"] {
    const mapped = STATUS_MAP[String(status)];
    if (!mapped) {
      throw new Error(`Unknown Mercado Pago payment status: ${String(status)}`);
    }
    return mapped;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    init: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<any> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

    const text = await response.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const message = parsed?.message ?? text ?? response.statusText;
      throw new Error(`Mercado Pago API error ${response.status}: ${message}`);
    }

    return parsed;
  }
}

/**
 * Verify Mercado Pago's `x-signature` header:
 *   ts=<unix seconds>,v1=<hex hmac>
 * HMAC-SHA256 over `id:<paymentId>;request-id:<x-request-id>;ts:<ts>;`
 */
export function verifyMpSignature(params: {
  signature: string;
  requestId: string;
  paymentId: string;
  webhookSecret: string;
}): void {
  if (!params.signature) {
    throw new Error("Missing webhook signature");
  }

  const parts = Object.fromEntries(
    params.signature
      .split(",")
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.includes("="))
      .map((chunk) => {
        const idx = chunk.indexOf("=");
        return [chunk.slice(0, idx), chunk.slice(idx + 1)] as const;
      }),
  );

  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) {
    throw new Error("Malformed webhook signature");
  }

  const manifest = `id:${params.paymentId};request-id:${params.requestId};ts:${ts};`;
  const expected = crypto
    .createHmac("sha256", params.webhookSecret)
    .update(manifest, "utf8")
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(v1, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("Invalid webhook signature");
  }

  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
  if (!Number.isFinite(Number(ts)) || skew > 300) {
    throw new Error("Webhook timestamp outside of the accepted window");
  }
}

function extractPaymentId(payload: unknown, signature: string): string | null {
  if (payload && typeof payload === "object") {
    const data = (payload as any).data;
    if (data && typeof data.id !== "undefined") return String(data.id);
    if (typeof (payload as any).id !== "undefined") return String((payload as any).id);
  }

  // Fall back to the `id=` field carried in the signature query manifest.
  const match = /(?:^|[?&])id=([^&]+)/.exec(signature);
  return match ? decodeURIComponent(match[1]) : null;
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

async function svgDataUri(text: string): Promise<string> {
  const { renderQrCodeDataUri } = await import("./qr-code.js");
  return renderQrCodeDataUri(text);
}
