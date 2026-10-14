/**
 * Pix BR Code (EMV® QRCPS-MPM) builder
 *
 * Generates the "Pix copia e cola" payload used by the QR Code.
 * Follows the Banco Central do Brasil payment brand specification.
 */

/** CRC16/CCITT-FALSE — required by the BR Code specification. */
export function crc16CcittFalse(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function tlv(id: string, value: string): string {
  return `${id}${String(value.length).padStart(2, "0")}${value}`;
}

function sanitize(value: string, maxLength: number): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9 $%*+\-./:]/g, "")
    .trim()
    .slice(0, maxLength)
    .toUpperCase();
}

export interface BuildBrCodeParams {
  /** Pix key (e-mail, telephone, EVP or random key). */
  key: string;
  /** Amount in centavos. Omit to build a dynamic (amount-less) QR. */
  amountCents?: number;
  /** Merchant name shown in the payer's app. */
  merchantName: string;
  /** Merchant city shown in the payer's app. */
  merchantCity: string;
  /** Transaction id (txid), up to 25 alphanumeric characters. */
  txid: string;
  description?: string;
}

/**
 * Build a Pix copia e cola payload.
 */
export function buildBrCode(params: BuildBrCodeParams): string {
  const merchantAccount =
    tlv("00", "br.gov.bcb.pix") +
    tlv("01", params.key.trim()) +
    (params.description ? tlv("02", sanitize(params.description, 40)) : "");

  const additionalData = tlv("05", sanitize(params.txid, 25) || "***");

  let payload =
    tlv("00", "01") + // Payload format indicator
    tlv("01", "11") + // Point of initiation: single use
    tlv("26", merchantAccount) +
    tlv("52", "0000") + // Merchant category code
    tlv("53", "986") + // Currency: BRL
    (params.amountCents !== undefined
      ? tlv("54", (params.amountCents / 100).toFixed(2))
      : "") +
    tlv("58", "BR") +
    tlv("59", sanitize(params.merchantName, 25) || "AUTOMATON") +
    tlv("60", sanitize(params.merchantCity, 15) || "SAO PAULO") +
    tlv("62", additionalData);

  // The CRC16 is computed over the whole payload including the literal
  // "6304" header/length of the CRC field itself (EMV® §4.1.6 / BR Code).
  payload += "6304" + crc16CcittFalse(payload + "6304");
  return payload;
}
