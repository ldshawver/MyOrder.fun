/**
 * Customer-receipt logo for the Mac Brightek.
 *
 * The bridge prints that queue through the Caysn raster filter, which draws
 * text and ignores an ESC/POS bitmap stuffed into the text file. The same
 * bridge prints a PDF as one slip. This module builds that slip: the exact
 * LC-Logo-BLK.png at half the previous printable width, then the receipt text.
 * Black pixels stay black. Transparent pixels become unprinted white.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import sharp from "sharp";

/** SHA-256 of /home/serveradmin/LC-Logo-BLK.png. Any other file is refused. */
export const LUCIFER_RECEIPT_LOGO_SHA256 = "006a1be7bde7ed514c805c50b45835847687b001e8f97795395e76272290ebb3";

const POINTS_PER_MM = 72 / 25.4;

export function customerReceiptUsesLogoImage(settings: {
  includeLogo?: boolean | null;
  receiptTemplateStyle?: string | null;
}, brandName: unknown): boolean {
  if (typeof brandName !== "string" || brandName.trim().toLowerCase() !== "lucifer cruz") return false;
  if (settings.includeLogo === false) return false;
  if (settings.receiptTemplateStyle === "compact") return false;
  return true;
}

export function receiptPaperWidth(columns: number): "58mm" | "80mm" {
  return columns <= 32 ? "58mm" : "80mm";
}

export function receiptPageWidthPt(paperWidth: "58mm" | "80mm"): number {
  return (paperWidth === "58mm" ? 58 : 80) * POINTS_PER_MM;
}

export function receiptLogoGeometry(paperWidth: "58mm" | "80mm", width: number, height: number) {
  const pageWidth = receiptPageWidthPt(paperWidth);
  const logoWidth = (pageWidth - 16) * 0.5;
  return { width: logoWidth, height: logoWidth * height / width, x: (pageWidth - logoWidth) / 2 };
}

function receiptLogoFile(): string {
  const moduleDir = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDir, "assets", "LC-Logo-BLK.png"),
    path.join(moduleDir, "lib/print/assets", "LC-Logo-BLK.png"),
    path.join(moduleDir, "..", "assets", "LC-Logo-BLK.png"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error("Lucifer Cruz receipt logo is not in the print assets");
  return found;
}

export function loadLuciferReceiptLogo(): Buffer {
  const bytes = fs.readFileSync(receiptLogoFile());
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== LUCIFER_RECEIPT_LOGO_SHA256) throw new Error("Lucifer Cruz receipt logo does not match the approved file");
  return bytes;
}

/** White paper behind the transparent mark. Does not invert the black ink. */
export async function flattenReceiptLogo(source: Buffer): Promise<Buffer> {
  return sharp(source).flatten({ background: "#ffffff" }).png().toBuffer();
}

/** Keep column spaces. Drop only characters Courier cannot draw. */
export function receiptPdfLine(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F-\u009F\p{Cf}]/gu, "") // eslint-disable-line no-control-regex -- Courier cannot draw controls
    .replace(/\u2026/g, "...")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, "\"")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u00B7\u2022]/g, "-")
    .replace(/[^\u0020-\u007E]/g, "?");
}

function courierSize(fontWidth: (size: number) => number, columns: number, maxWidth: number): number {
  let size = 9;
  while (size > 5 && fontWidth(size) * columns > maxWidth) size -= 0.25;
  return size;
}

/**
 * One receipt page. The logo keeps its aspect ratio and is inset from the
 * paper edge. The body is the plain receipt, without the text wordmark.
 */
export async function composeLuciferReceiptPdf(plainText: string, paperWidth: "58mm" | "80mm"): Promise<Uint8Array> {
  const logoPng = await flattenReceiptLogo(loadLuciferReceiptLogo());
  const doc = await PDFDocument.create();
  const logo = await doc.embedPng(logoPng);
  const courier = await doc.embedFont(StandardFonts.Courier);
  const pageWidth = receiptPageWidthPt(paperWidth);
  const margin = 8;
  const contentWidth = pageWidth - margin * 2;
  const geometry = receiptLogoGeometry(paperWidth, logo.width, logo.height);
  const logoWidth = geometry.width;
  const logoHeight = geometry.height;
  const columns = paperWidth === "58mm" ? 32 : 48;
  const fontSize = courierSize((size) => courier.widthOfTextAtSize("M", size), columns, contentWidth);
  const lineHeight = fontSize * 1.25;
  const lines = plainText.replace(/\r\n/g, "\n").split("\n").flatMap(line => {
    const safe = receiptPdfLine(line);
    if (!safe.length) return [""];
    const wrapped: string[] = [];
    for (let start = 0; start < safe.length; start += columns) wrapped.push(safe.slice(start, start + columns));
    return wrapped;
  });
  // Center the whole body, preserving the spaces aligning descriptions/prices.
  const bodyWidth = Math.max(0, ...lines.map(line => courier.widthOfTextAtSize(line, fontSize)));
  const bodyX = (pageWidth - bodyWidth) / 2;
  const textHeight = Math.max(lineHeight, lines.length * lineHeight);
  const pageHeight = margin + logoHeight + 8 + textHeight + 14;
  const page = doc.addPage([pageWidth, pageHeight]);
  page.drawImage(logo, {
    x: geometry.x,
    y: pageHeight - margin - logoHeight,
    width: logoWidth,
    height: logoHeight,
  });
  let cursor = pageHeight - margin - logoHeight - 8 - fontSize;
  for (const line of lines) {
    const safe = receiptPdfLine(line);
    if (safe.length > 0) {
      page.drawText(safe, { x: bodyX, y: cursor, size: fontSize, font: courier, color: rgb(0, 0, 0) });
    }
    cursor -= lineHeight;
  }
  doc.setTitle("Receipt");
  return doc.save();
}
