/**
 * Pix provider configuration and factory.
 *
 * The application never talks to a specific gateway directly — it resolves a
 * `PixProvider` from configuration, so swapping Mercado Pago for Efí, Asaas,
 * PagBank or any other gateway is a configuration change.
 *
 * Credentials are only read from the environment. They are never hard-coded.
 */

import { MockPixProvider } from "./mock-provider.js";
import { MercadoPagoPixProvider } from "./mercadopago-provider.js";
import type { PixProvider } from "./types.js";

export type PixProviderName = "mock" | "mercadopago";

export type PixEnvironment = "development" | "test" | "production";

export interface PixConfig {
  provider: PixProviderName;
  environment: PixEnvironment;
  apiKey: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  baseUrl?: string;
  /** Optional Pix key used by local providers to build BR Codes. */
  pixKey?: string;
}

export class PixConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PixConfigError";
  }
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string {
  return (env[key] ?? "").trim();
}

/**
 * Build the Pix configuration from environment variables.
 * Throws when a real gateway is selected without credentials.
 */
export function loadPixConfig(env: NodeJS.ProcessEnv = process.env): PixConfig {
  const provider = (readEnv(env, "PIX_PROVIDER") || "mock").toLowerCase() as PixProviderName;
  const environment = (readEnv(env, "PIX_ENVIRONMENT") || "development")
    .toLowerCase() as PixEnvironment;

  if (!["development", "test", "production"].includes(environment)) {
    throw new PixConfigError(
      `PIX_ENVIRONMENT must be development, test or production (got "${environment}")`,
    );
  }

  const config: PixConfig = {
    provider,
    environment,
    apiKey: readEnv(env, "PIX_API_KEY"),
    clientId: readEnv(env, "PIX_CLIENT_ID"),
    clientSecret: readEnv(env, "PIX_CLIENT_SECRET"),
    webhookSecret: readEnv(env, "PIX_WEBHOOK_SECRET"),
    baseUrl: readEnv(env, "PIX_BASE_URL") || undefined,
    pixKey: readEnv(env, "PIX_KEY") || undefined,
  };

  if (provider !== "mock") {
    const missing: string[] = [];
    if (!config.apiKey) missing.push("PIX_API_KEY");
    if (!config.webhookSecret) missing.push("PIX_WEBHOOK_SECRET");
    if (missing.length) {
      throw new PixConfigError(
        `Missing credentials for PIX_PROVIDER=${provider}: ${missing.join(", ")}`,
      );
    }
  }

  if (provider === "mock" && !config.webhookSecret) {
    // Development fallback: keeps local webhooks verifiable. Production
    // requires an explicit secret (checked below).
    if (environment === "production") {
      throw new PixConfigError("PIX_WEBHOOK_SECRET is required in production");
    }
    config.webhookSecret = "dev-only-pix-webhook-secret";
  }

  return config;
}

/**
 * Resolve the configured Pix provider.
 */
export function createPixProvider(config: PixConfig): PixProvider {
  switch (config.provider) {
    case "mock":
      return new MockPixProvider({
        webhookSecret: config.webhookSecret,
        pixKey: config.pixKey,
      });
    case "mercadopago":
      return new MercadoPagoPixProvider({
        accessToken: config.apiKey,
        webhookSecret: config.webhookSecret,
        environment: config.environment,
        baseUrl: config.baseUrl,
      });
    default:
      throw new PixConfigError(`Unsupported PIX_PROVIDER: ${String(config.provider)}`);
  }
}
