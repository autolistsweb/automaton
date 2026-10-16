/**
 * Payments module — BRL / Pix money movement.
 *
 * Public surface of the module: money helpers, the `PixProvider` interface,
 * the concrete providers, the `PixPaymentService` that owns balance changes
 * and the webhook server that receives provider notifications.
 */

export * from "./money.js";
export * from "./types.js";
export { loadPixConfig, createPixProvider, PixConfigError } from "./provider.js";
export type { PixConfig, PixProviderName, PixEnvironment } from "./provider.js";
export { MockPixProvider } from "./mock-provider.js";
export { MercadoPagoPixProvider, verifyMpSignature } from "./mercadopago-provider.js";
export { buildBrCode, crc16CcittFalse } from "./br-code.js";
export { renderQrCodeDataUri } from "./qr-code.js";
export {
  PixPaymentService,
  PixWebhookError,
} from "./pix-payment-service.js";
export type {
  CreateChargeResult,
  PixPaymentServiceOptions,
} from "./pix-payment-service.js";
export {
  startPixWebhookServer,
  PIX_WEBHOOK_PATH,
} from "./webhook-server.js";
export type { WebhookServer, WebhookServerOptions } from "./webhook-server.js";

import type Database from "better-sqlite3";
import { loadPixConfig, createPixProvider } from "./provider.js";
import { PixPaymentService } from "./pix-payment-service.js";

/**
 * Build a ready-to-use `PixPaymentService` from environment configuration.
 */
export function createPixPaymentService(
  db: Database.Database,
  env: NodeJS.ProcessEnv = process.env,
): PixPaymentService {
  const config = loadPixConfig(env);
  const provider = createPixProvider(config);
  return new PixPaymentService({ db, provider });
}
