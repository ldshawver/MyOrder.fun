import { createHash } from "node:crypto";
import { PDFArray, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  composeLuciferReceiptPdf, loadLuciferReceiptLogo, LUCIFER_RECEIPT_LOGO_SHA256,
  receiptLogoGeometry, receiptPageWidthPt, receiptPdfLine,
  customerReceiptUsesLogoImage,
} from "../print/receiptLogo";

describe("half-width Lucifer Cruz receipt logo", () => {
  it("keeps the exact approved artwork and places it at half the former width", () => {
    expect(createHash("sha256").update(loadLuciferReceiptLogo()).digest("hex")).toBe(LUCIFER_RECEIPT_LOGO_SHA256);
    for (const paper of ["58mm", "80mm"] as const) {
      const layout = receiptLogoGeometry(paper, 1024, 346);
      expect(layout.width).toBeCloseTo((receiptPageWidthPt(paper) - 16) / 2);
      expect(layout.height / layout.width).toBeCloseTo(346 / 1024);
      expect(layout.x * 2 + layout.width).toBeCloseTo(receiptPageWidthPt(paper));
      expect(layout.x).toBeGreaterThan(8);
    }
  });

  it("builds a single unclipped image receipt with space for the whole body", async () => {
    const short = await PDFDocument.load(await composeLuciferReceiptPdf("SAMPLE ONLY\nTOTAL 10.00", "80mm"));
    const long = await PDFDocument.load(await composeLuciferReceiptPdf("SAMPLE ONLY\n".repeat(35), "80mm"));
    expect(short.getPageCount()).toBe(1);
    expect(short.getPage(0).node.Resources()?.has(PDFName.of("XObject"))).toBe(true);
    expect(long.getPage(0).getHeight()).toBeGreaterThan(short.getPage(0).getHeight());
    expect(receiptPdfLine("TOTAL\x1bp\x00 10.00")).toBe("TOTALp 10.00");
  });

  it("centers the body as a block without disturbing description/amount columns", async () => {
    const document = await PDFDocument.load(await composeLuciferReceiptPdf("Item           10.00\nTOTAL          10.00", "80mm"));
    const contents = document.getPage(0).node.Contents() as PDFArray;
    const stream = contents.lookup(0, PDFRawStream);
    const operators = inflateSync(stream.getContents()).toString("latin1");
    const positions = [...operators.matchAll(/1 0 0 1 ([\d.]+) [\d.]+ Tm/g)].map(match => Number(match[1]));
    const fontSize = Number(operators.match(/\/\S+ ([\d.]+) Tf/)?.[1]);
    expect(positions).toHaveLength(2);
    const textTransform = [...operators.matchAll(/^([\d.]+) 0 0 1 ([\d.]+) 0 cm$/gm)].at(-1);
    const scale = Number(textTransform?.[1]);
    const left = Number(textTransform?.[2]);
    expect(fontSize).toBe(10);
    expect(scale).toBeGreaterThan(0);
    expect(scale).toBeLessThan(1);
    expect(left).toBeCloseTo((receiptPageWidthPt("80mm") - 20 * fontSize * 0.6 * scale) / 2);
    expect(positions).toEqual([0, 0]);
  });

  it("respects tenant identity, disabled logos and compact receipts", () => {
    expect(customerReceiptUsesLogoImage({}, "Lucifer Cruz")).toBe(true);
    expect(customerReceiptUsesLogoImage({}, "Other Shop")).toBe(false);
    expect(customerReceiptUsesLogoImage({ includeLogo: false }, "Lucifer Cruz")).toBe(false);
    expect(customerReceiptUsesLogoImage({ receiptTemplateStyle: "compact" }, "Lucifer Cruz")).toBe(false);
  });
});
