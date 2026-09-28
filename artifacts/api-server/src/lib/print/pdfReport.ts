/**
 * pdfReport.ts — full-page (US Letter) documents rendered on the server.
 *
 * A ReportDocument is plain data (title, context, summary, tables). This
 * module lays it out as a PDF: a title block on every page, page numbers,
 * table headers repeated after page breaks, totals rows, and text fitted to
 * its column. PDF is the canonical full-page representation: it is produced
 * here, stored on the print job, and printed as-is by the bridge, so output
 * never depends on a browser. Metadata dates come from the document, so the
 * same document always produces the same bytes.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

export interface ReportColumn {
  readonly key: string;
  readonly label: string;
  readonly align?: "left" | "right";
  /** Relative width; columns share the page width in proportion. */
  readonly weight?: number;
}

export interface ReportSection {
  readonly heading?: string;
  readonly columns: readonly ReportColumn[];
  readonly rows: ReadonlyArray<Readonly<Record<string, string>>>;
  readonly totals?: Readonly<Record<string, string>>;
  readonly emptyText?: string;
}

export interface ReportDocument {
  readonly title: string;
  readonly businessName: string;
  readonly locationName?: string | null;
  /** ISO instant the document data was generated. */
  readonly generatedAt: string;
  readonly timezone: string;
  readonly generatedBy?: string | null;
  readonly rangeLabel?: string | null;
  readonly summary?: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly sections: readonly ReportSection[];
  readonly footerNote?: string | null;
}

const PAGE = { width: 612, height: 792 }; // 8.5 x 11 in at 72 pt/in
const MARGIN = 40;
const BODY_SIZE = 9;
const ROW_HEIGHT = 15;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.38, 0.4, 0.44);
const RULE = rgb(0.75, 0.77, 0.8);
const HEADER_FILL = rgb(0.92, 0.93, 0.95);

/** Standard PDF fonts use WinAnsi: map common marks, drop the rest. */
export function pdfSafeText(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F-\u009F\p{Cf}]/gu, " ") // eslint-disable-line no-control-regex -- stripping controls
    .replace(/\u2026/g, "...")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u00B7\u2022]/g, "-")
    .replace(/[^\u0020-\u007E\u00A0-\u00FF]/g, "?")
    .replace(/\s+/g, " ")
    .trim();
}

function fit(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}...`, size) > maxWidth) out = out.slice(0, -1);
  return `${out}...`;
}

export function formatReportDate(isoInstant: string, timeZone: string): string {
  const date = new Date(isoInstant);
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" };
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(date);
  } catch {
    return `${new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(date)} UTC`;
  }
}

export async function renderReportPdf(doc: ReportDocument): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const generated = new Date(doc.generatedAt);
  pdf.setTitle(pdfSafeText(doc.title));
  pdf.setProducer("MyOrder.fun");
  pdf.setCreator("MyOrder.fun");
  pdf.setCreationDate(generated);
  pdf.setModificationDate(generated);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const contentWidth = PAGE.width - MARGIN * 2;
  const bottom = MARGIN + 28;

  let page!: PDFPage;
  let y = 0;
  const text = (value: string, x: number, atY: number, size: number, font = regular, color = INK) =>
    page.drawText(value, { x, y: atY, size, font, color });

  const contextLine = [
    doc.businessName,
    doc.locationName,
    `Generated ${formatReportDate(doc.generatedAt, doc.timezone)}`,
    doc.generatedBy ? `by ${doc.generatedBy}` : null,
  ].filter(Boolean).map(pdfSafeText).join("  |  ");

  const newPage = () => {
    page = pdf.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - MARGIN;
    text(fit(pdfSafeText(doc.title), bold, 16, contentWidth), MARGIN, y - 16, 16, bold);
    y -= 32;
    text(fit(contextLine, regular, BODY_SIZE, contentWidth), MARGIN, y, BODY_SIZE, regular, MUTED);
    y -= 13;
    if (doc.rangeLabel) {
      text(fit(pdfSafeText(doc.rangeLabel), regular, BODY_SIZE, contentWidth), MARGIN, y, BODY_SIZE, regular, MUTED);
      y -= 13;
    }
    page.drawLine({ start: { x: MARGIN, y: y + 4 }, end: { x: PAGE.width - MARGIN, y: y + 4 }, thickness: 0.8, color: RULE });
    y -= 12;
  };
  const ensure = (height: number) => {
    if (y - height < bottom) {
      newPage();
      return true;
    }
    return false;
  };

  newPage();

  if (doc.summary?.length) {
    const colWidth = contentWidth / 3;
    doc.summary.forEach((item, index) => {
      const col = index % 3;
      if (col === 0) ensure(30);
      const x = MARGIN + col * colWidth;
      text(fit(pdfSafeText(item.label).toUpperCase(), regular, 7, colWidth - 8), x, y, 7, regular, MUTED);
      text(fit(pdfSafeText(item.value), bold, 11, colWidth - 8), x, y - 13, 11, bold);
      if (col === 2 || index === doc.summary!.length - 1) y -= 30;
    });
    y -= 4;
  }

  for (const section of doc.sections) {
    // Every column first gets room for its header label; the remaining width
    // is shared by weight, so headers are never truncated.
    const weights = section.columns.map((column) => column.weight ?? 1);
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    const minimums = section.columns.map((column) => bold.widthOfTextAtSize(pdfSafeText(column.label), BODY_SIZE) + 10);
    const spare = Math.max(0, contentWidth - minimums.reduce((sum, width) => sum + width, 0));
    const widths = minimums.map((minimum, index) => minimum + (weights[index]! / totalWeight) * spare);
    const cellX = (index: number) => MARGIN + widths.slice(0, index).reduce((sum, width) => sum + width, 0);

    const drawCells = (values: Readonly<Record<string, string>>, font: PDFFont) => {
      section.columns.forEach((column, index) => {
        const width = widths[index]! - 8;
        const value = fit(pdfSafeText(values[column.key] ?? ""), font, BODY_SIZE, width);
        const x = column.align === "right"
          ? cellX(index) + widths[index]! - 4 - font.widthOfTextAtSize(value, BODY_SIZE)
          : cellX(index) + 4;
        text(value, x, y, BODY_SIZE, font);
      });
    };
    const drawHeader = (continued: boolean) => {
      if (section.heading) {
        text(fit(pdfSafeText(section.heading) + (continued ? " (continued)" : ""), bold, 11, contentWidth), MARGIN, y, 11, bold);
        y -= 16;
      }
      page.drawRectangle({ x: MARGIN, y: y - 4, width: contentWidth, height: ROW_HEIGHT, color: HEADER_FILL });
      drawCells(Object.fromEntries(section.columns.map((column) => [column.key, column.label])), bold);
      y -= ROW_HEIGHT;
    };

    ensure(16 + ROW_HEIGHT * 3);
    drawHeader(false);
    if (!section.rows.length) {
      text(pdfSafeText(section.emptyText ?? "No rows"), MARGIN + 4, y, BODY_SIZE, regular, MUTED);
      y -= ROW_HEIGHT;
    }
    for (const row of section.rows) {
      if (ensure(ROW_HEIGHT)) drawHeader(true);
      drawCells(row, regular);
      page.drawLine({ start: { x: MARGIN, y: y - 4 }, end: { x: PAGE.width - MARGIN, y: y - 4 }, thickness: 0.3, color: RULE });
      y -= ROW_HEIGHT;
    }
    if (section.totals) {
      if (ensure(ROW_HEIGHT + 4)) drawHeader(true);
      page.drawLine({ start: { x: MARGIN, y: y + 11 }, end: { x: PAGE.width - MARGIN, y: y + 11 }, thickness: 1, color: INK });
      drawCells(section.totals, bold);
      y -= ROW_HEIGHT;
    }
    y -= 14;
  }

  if (doc.footerNote) {
    ensure(20);
    text(fit(pdfSafeText(doc.footerNote), regular, 8, contentWidth), MARGIN, y, 8, regular, MUTED);
  }

  const pages = pdf.getPages();
  pages.forEach((current, index) => {
    const label = `Page ${index + 1} of ${pages.length}`;
    current.drawText(label, {
      x: PAGE.width - MARGIN - regular.widthOfTextAtSize(label, 8), y: MARGIN - 8, size: 8, font: regular, color: MUTED,
    });
    current.drawText(fit(pdfSafeText(doc.title), regular, 8, contentWidth / 2), { x: MARGIN, y: MARGIN - 8, size: 8, font: regular, color: MUTED });
  });

  return pdf.save({ useObjectStreams: false });
}
