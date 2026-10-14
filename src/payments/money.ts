/**
 * BRL Money Helpers
 *
 * All monetary values in this codebase are integers in centavos (cents) of
 * Brazilian Real (BRL). Floats are never used to store money.
 *
 * R$ 19,90  <->  1990
 */

/** ISO-4217 code for the only currency supported by the platform. */
export const BRL_CURRENCY = "BRL" as const;

export type BrlCurrency = typeof BRL_CURRENCY;

/** Minimum accepted top-up/charge: R$ 1,00. */
export const MIN_CHARGE_CENTS = 100;

/** Maximum accepted top-up/charge: R$ 10.000,00. */
export const MAX_CHARGE_CENTS = 1_000_000;

/** Default preset top-up amounts offered in the UI: R$ 10 / 25 / 50 / 100. */
export const PIX_PRESET_AMOUNTS_CENTS = [1000, 2500, 5000, 10000] as const;

const brlFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Format an integer amount in centavos as Brazilian currency.
 *
 * formatBRL(1990)  -> "R$ 19,90"
 * formatBRL(0)     -> "R$ 0,00"
 * formatBRL(-1290) -> "-R$ 12,90"
 */
export function formatBRL(cents: number): string {
  if (!Number.isFinite(cents)) {
    throw new Error(`Invalid BRL amount: ${cents}`);
  }
  return brlFormatter.format(cents / 100);
}

/**
 * Parse a user supplied amount (string or number) into centavos.
 * Accepts "25", "25,90", "R$ 25,90", 25.9.
 *
 * Throws when the value cannot be represented as a whole number of cents.
 */
export function parseBRLToCents(input: string | number): number {
  if (typeof input === "number") {
    return toCents(input);
  }

  const normalized = input
    .replace(/\s|R\$/gi, "")
    .replace(/\./g, "")
    .replace(",", ".");

  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`Invalid BRL amount: ${input}`);
  }

  return toCents(Number(normalized));
}

function toCents(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid BRL amount: ${value}`);
  }
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) > 1e-6) {
    throw new Error(`Amount has more than two decimal places: ${value}`);
  }
  return cents;
}

/**
 * Validate an integer centavo amount for a new Pix charge.
 * Returns an error message, or null when the amount is acceptable.
 */
export function validateAmountCents(
  cents: unknown,
  limits: { min?: number; max?: number } = {},
): string | null {
  const min = limits.min ?? MIN_CHARGE_CENTS;
  const max = limits.max ?? MAX_CHARGE_CENTS;
  if (typeof cents !== "number" || !Number.isInteger(cents)) {
    return "amountCents must be an integer number of centavos";
  }
  if (cents < min) {
    return `Minimum amount is ${formatBRL(min)}`;
  }
  if (cents > max) {
    return `Maximum amount is ${formatBRL(max)}`;
  }
  return null;
}
