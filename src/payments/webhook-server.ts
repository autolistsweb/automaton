/**
 * Pix webhook server.
 *
 * Exposes `POST /api/payments/pix/webhook`, the single endpoint through
 * which a Pix provider may confirm that money actually moved.
 *
 * Security properties:
 *  - only `POST` is accepted, everything else gets 404/405;
 *  - the body is size-limited (413) and must be valid JSON (400);
 *  - the payload is authenticated by the provider (HMAC signature + replay
 *    window) inside `PixPaymentService.handleWebhook`; authentication
 *    failures answer 401 instead of a generic 500;
 *  - the endpoint is idempotent: duplicate deliveries return 200 without
 *    crediting the balance twice;
 *  - failures never partially apply: the balance is credited inside a single
 *    database transaction.
 */

import http from "node:http";
import { createLogger } from "../observability/logger.js";
import { PixPaymentService, PixWebhookError } from "./pix-payment-service.js";
import { PixWebhookAuthError } from "./types.js";

const logger = createLogger("payments.webhook");

export const PIX_WEBHOOK_PATH = "/api/payments/pix/webhook";
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_PORT = Number(process.env.PIX_WEBHOOK_PORT ?? 8787);

export interface WebhookServerOptions {
  service: PixPaymentService;
  port?: number;
  host?: string;
}

export interface WebhookServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Start a small HTTP server dedicated to webhook deliveries.
 */
export async function startPixWebhookServer(
  options: WebhookServerOptions,
): Promise<WebhookServer> {
  const { service } = options;
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? DEFAULT_PORT;

  const server = http.createServer((req, res) => {
    void handle(req, res, service);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : port;

  logger.info(`Pix webhook server listening on http://${host}:${actualPort}${PIX_WEBHOOK_PATH}`);

  return {
    url: `http://${host}:${actualPort}${PIX_WEBHOOK_PATH}`,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  service: PixPaymentService,
): Promise<void> {
  const send = (
    status: number,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(payload),
      "Cache-Control": "no-store",
      ...extraHeaders,
    });
    res.end(payload);
  };

  try {
    if (req.method !== "POST") {
      if (req.method === "GET" || req.method === "HEAD") {
        send(405, { error: "method_not_allowed" });
      } else {
        send(404, { error: "not_found" });
      }
      return;
    }

    const path = (req.url ?? "").split("?")[0];
    if (path !== PIX_WEBHOOK_PATH) {
      send(404, { error: "not_found" });
      return;
    }

    const raw = await readBody(req);
    if (raw === null) {
      // Answer before tearing the connection down: `Connection: close` makes
      // the server end the socket only after this response has been flushed,
      // so the client receives the 413 instead of a socket reset.
      send(413, { error: "payload_too_large" }, { Connection: "close" });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      send(400, { error: "invalid_json" });
      return;
    }

    const result = await service.handleWebhook(payload, req.headers);

    logger.info(
      `Webhook processed: charge=${result.chargeId} duplicate=${result.duplicate} balance=${result.balanceCents}`,
    );

    send(200, {
      ok: true,
      duplicate: result.duplicate,
      charge_id: result.chargeId,
      balance_cents: result.balanceCents,
    });
  } catch (err: any) {
    if (err instanceof PixWebhookError || err instanceof PixWebhookAuthError) {
      logger.warn(`Webhook rejected (${err.statusCode}): ${err.message}`);
      send(err.statusCode, { error: err.message });
      return;
    }
    logger.error(`Webhook failed: ${err?.message ?? err}`);
    send(500, { error: "internal_error" });
  }
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;

    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      resolve(value);
    };

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop buffering but keep draining: destroying the request here would
        // reset the socket before the 413 response could be delivered.
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => finish(null));
  });
}
