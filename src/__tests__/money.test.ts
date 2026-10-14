/**
 * BRL money helper unit tests — src/payments/money.ts
 *
 * All monetary values are integers in centavos of BRL.
 */

import { describe, it, expect } from "vitest";
import {
  BRL_CURRENCY,
  MAX_CHARGE_CENTS,
  MIN_CHARGE_CENTS,
  PIX_PRESET_AMOUNTS_CENTS,
  formatBRL,
  parseBRLToCents,
  validateAmountCents,
} from "../payments/money.js";

/** Intl may separate "R$" from the digits with NBSP / narrow NBSP. */
function brl(label: string): string {
  return label.replace(/[\u00A0\u202F]/g, " ");
}

describe("money constants", () => {
  it("uses BRL as the single currency", () => {
    expect(BRL_CURRENCY).toBe("BRL");
  });

  it("defines the charge bounds in centavos", () => {
    expect(MIN_CHARGE_CENTS).toBe(100);
    expect(MAX_CHARGE_CENTS).toBe(1_000_000);
    expect(Number.isInteger(MIN_CHARGE_CENTS)).toBe(true);
    expect(Number.isInteger(MAX_CHARGE_CENTS)).toBe(true);
  });
});

describe("formatBRL", () => {
  it("formats zero and whole reais", () => {
    expect(brl(formatBRL(0))).toBe("R$ 0,00");
    expect(brl(formatBRL(100))).toBe("R$ 1,00");
    expect(brl(formatBRL(100000))).toBe("R$ 1.000,00");
  });

  it("formats centavos with pt-BR separators", () => {
    expect(brl(formatBRL(1990))).toBe("R$ 19,90");
    expect(brl(formatBRL(1))).toBe("R$ 0,01");
  });

  it("formats large values with dot thousands separators", () => {
    expect(brl(formatBRL(123456789))).toBe("R$ 1.234.567,89");
    expect(brl(formatBRL(MAX_CHARGE_CENTS))).toBe("R$ 10.000,00");
    expect(brl(formatBRL(999999))).toBe("R$ 9.999,99");
  });

  it("formats negative amounts", () => {
    expect(brl(formatBRL(-1290))).toBe("-R$ 12,90");
  });

  it("always renders two decimals and a currency prefix", () => {
    for (const cents of [0, 1, 1990, 2500, 10000, 999999, 123456789]) {
      expect(brl(formatBRL(cents))).toMatch(/^R\$ \d{1,3}(\.\d{3})*,\d{2}$/);
    }
  });

  it("rejects non-finite amounts", () => {
    expect(() => formatBRL(Number.NaN)).toThrow(/Invalid BRL amount/);
    expect(() => formatBRL(Infinity)).toThrow(/Invalid BRL amount/);
    expect(() => formatBRL(-Infinity)).toThrow(/Invalid BRL amount/);
  });
});

describe("parseBRLToCents", () => {
  it("accepts pt-BR decimal strings", () => {
    expect(parseBRLToCents("19,90")).toBe(1990);
    expect(parseBRLToCents("1.234,56")).toBe(123456);
    expect(parseBRLToCents("0,50")).toBe(50);
    expect(parseBRLToCents("1.000")).toBe(100000);
  });

  it("accepts currency-prefixed strings", () => {
    expect(parseBRLToCents("R$ 19,90")).toBe(1990);
    expect(parseBRLToCents("R$1.000,00")).toBe(100000);
    expect(parseBRLToCents("R$ 10")).toBe(1000);
  });

  it("accepts plain integers and numeric input", () => {
    expect(parseBRLToCents("25")).toBe(2500);
    expect(parseBRLToCents("0")).toBe(0);
    expect(parseBRLToCents(25.9)).toBe(2590);
    expect(parseBRLToCents(0)).toBe(0);
    expect(parseBRLToCents(1990)).toBe(199000);
  });

  it("rejects garbage and empty input", () => {
    const bad = ["", "   ", "abc", "R$", "1,2,3", "12,34,56", "--5", "19,90x", "R$ abc"];
    for (const input of bad) {
      expect(() => parseBRLToCents(input), `expected "${input}" to throw`).toThrow(
        /Invalid BRL amount/,
      );
    }
  });

  it("rejects amounts with more than two decimal places", () => {
    expect(() => parseBRLToCents("19,999")).toThrow(/two decimal places/);
    expect(() => parseBRLToCents(19.999)).toThrow(/two decimal places/);
  });

  it("rejects non-finite numbers", () => {
    expect(() => parseBRLToCents(Number.NaN)).toThrow(/Invalid BRL amount/);
    expect(() => parseBRLToCents(Infinity)).toThrow(/Invalid BRL amount/);
  });
});

describe("validateAmountCents", () => {
  it("accepts integer centavos inside the default bounds", () => {
    expect(validateAmountCents(MIN_CHARGE_CENTS)).toBeNull();
    expect(validateAmountCents(1990)).toBeNull();
    expect(validateAmountCents(100000)).toBeNull();
    expect(validateAmountCents(MAX_CHARGE_CENTS)).toBeNull();
  });

  it("rejects amounts below the minimum", () => {
    expect(brl(validateAmountCents(99) ?? "")).toBe("Minimum amount is R$ 1,00");
    expect(brl(validateAmountCents(MIN_CHARGE_CENTS - 1) ?? "")).toBe(
      "Minimum amount is R$ 1,00",
    );
  });

  it("rejects negative amounts", () => {
    expect(brl(validateAmountCents(-1) ?? "")).toBe("Minimum amount is R$ 1,00");
    expect(brl(validateAmountCents(-1990) ?? "")).toBe("Minimum amount is R$ 1,00");
  });

  it("rejects amounts above the maximum", () => {
    expect(brl(validateAmountCents(MAX_CHARGE_CENTS + 1) ?? "")).toBe(
      "Maximum amount is R$ 10.000,00",
    );
    expect(brl(validateAmountCents(2_000_000) ?? "")).toBe("Maximum amount is R$ 10.000,00");
  });

  it("rejects non-integer amounts", () => {
    for (const value of [1990.5, 0.01, Number.NaN, Infinity, -Infinity]) {
      expect(validateAmountCents(value), `expected ${value} to be rejected`).toMatch(
        /integer/,
      );
    }
  });

  it("rejects non-number values", () => {
    for (const value of ["1990", null, undefined, {}, []] as unknown[]) {
      expect(validateAmountCents(value)).toMatch(/integer/);
    }
  });

  it("honours custom min/max bounds", () => {
    expect(validateAmountCents(500, { min: 1000 })).toMatch(/Minimum/);
    expect(validateAmountCents(500, { max: 400 })).toMatch(/Maximum/);
    expect(validateAmountCents(0, { min: 0 })).toBeNull();
    expect(validateAmountCents(1500, { min: 1000, max: 2000 })).toBeNull();
    expect(validateAmountCents(2500, { min: 1000, max: 2000 })).toMatch(/Maximum/);
  });
});

describe("PIX_PRESET_AMOUNTS_CENTS", () => {
  it("exposes the R$ 10 / 25 / 50 / 100 tiers in centavos", () => {
    expect([...PIX_PRESET_AMOUNTS_CENTS]).toEqual([1000, 2500, 5000, 10000]);
    expect(PIX_PRESET_AMOUNTS_CENTS).toHaveLength(4);
  });

  it("keeps every preset integer and chargeable", () => {
    for (const cents of PIX_PRESET_AMOUNTS_CENTS) {
      expect(Number.isInteger(cents)).toBe(true);
      expect(validateAmountCents(cents)).toBeNull();
    }
  });

  it("formats each preset as pt-BR currency", () => {
    expect(brl(formatBRL(PIX_PRESET_AMOUNTS_CENTS[0]))).toBe("R$ 10,00");
    expect(brl(formatBRL(PIX_PRESET_AMOUNTS_CENTS[1]))).toBe("R$ 25,00");
    expect(brl(formatBRL(PIX_PRESET_AMOUNTS_CENTS[2]))).toBe("R$ 50,00");
    expect(brl(formatBRL(PIX_PRESET_AMOUNTS_CENTS[3]))).toBe("R$ 100,00");
  });

  it("keeps presets within the default charge bounds", () => {
    expect(Math.min(...PIX_PRESET_AMOUNTS_CENTS)).toBeGreaterThanOrEqual(MIN_CHARGE_CENTS);
    expect(Math.max(...PIX_PRESET_AMOUNTS_CENTS)).toBeLessThanOrEqual(MAX_CHARGE_CENTS);
  });
});
