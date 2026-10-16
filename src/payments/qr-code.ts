/**
 * QR Code rendering for Pix charges.
 *
 * Renders the "Pix copia e cola" payload as a scannable SVG data URI so it
 * can be embedded directly in the dashboard without a network round trip.
 */

import QRCode from "qrcode";

export interface RenderQrCodeOptions {
  /** Margin around the code, in modules. */
  margin?: number;
  /** Dark module color. */
  darkColor?: string;
  /** Light module color. */
  lightColor?: string;
}

/**
 * Render a payload as an SVG QR Code data URI.
 */
export async function renderQrCodeDataUri(
  payload: string,
  options: RenderQrCodeOptions = {},
): Promise<string> {
  const svg = await QRCode.toString(payload, {
    type: "svg",
    margin: options.margin ?? 2,
    errorCorrectionLevel: "M",
    color: {
      dark: options.darkColor ?? "#0B1220",
      light: options.lightColor ?? "#FFFFFF",
    },
  });

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
