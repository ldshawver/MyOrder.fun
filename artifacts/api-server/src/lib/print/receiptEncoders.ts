/**
 * receiptEncoders.ts — semantic receipt lines → printer bytes or preview text.
 *
 * This is the only layer that knows ESC/POS. It emits a fixed set of commands
 * (initialise, align, bold, character size, feed, cut). All text has
 * control characters stripped again here, so no content — including template
 * text or order data — can carry its own printer commands.
 */
import { stripControlCharacters } from "./receiptData";
import { columnsFor, type ReceiptLine, type ReceiptRuleStyle, type ReceiptTextSize, type RenderedReceiptLines } from "./receiptTemplateRenderer";

const ESC = "\x1b";
const GS = "\x1d";
const INIT = `${ESC}@`;
const ALIGN = { left: `${ESC}a\x00`, center: `${ESC}a\x01`, right: `${ESC}a\x02` } as const;
const BOLD = { on: `${ESC}E\x01`, off: `${ESC}E\x00` } as const;
const SIZE: Record<ReceiptTextSize, string> = { normal: `${GS}!\x00`, tall: `${GS}!\x01`, large: `${GS}!\x11` };
// Same trailer as the legacy renderer: feed 3 lines, partial cut.
const FEED_AND_CUT = `${ESC}d\x03${GS}VA\x00`;

/** Printer code pages are single-byte: map common typographic marks to ASCII. */
function printable(value: string): string {
  return stripControlCharacters(value)
    .replace(/\u2026/g, "...")
    .replace(/[\u00B7\u2022]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-");
}

function ruleText(style: ReceiptRuleStyle, columns: number): string {
  if (style === "double") return "=".repeat(columns);
  if (style === "dashed") return "- ".repeat(Math.ceil(columns / 2)).slice(0, columns);
  return "-".repeat(columns);
}

function justify(left: string, right: string, columns: number): string {
  const gap = Math.max(1, columns - left.length - right.length);
  return `${left}${" ".repeat(gap)}${right}`;
}

/** ESC/POS bytes (as a binary string) for the bridge's raw CUPS queue. */
export function encodeReceiptEscPos(receipt: RenderedReceiptLines): string {
  const out: string[] = [INIT];
  const style = (align: keyof typeof ALIGN, bold: boolean, size: ReceiptTextSize) =>
    out.push(ALIGN[align], bold ? BOLD.on : BOLD.off, SIZE[size]);
  for (const line of receipt.lines) {
    switch (line.kind) {
      case "text":
        style(line.align, line.bold, line.size);
        out.push(" ".repeat(line.indent ?? 0), printable(line.text), "\n");
        break;
      case "columns":
        style("left", line.bold, line.size);
        out.push(justify(printable(line.left), printable(line.right), columnsFor(receipt.width, line.size)), "\n");
        break;
      case "rule":
        style("left", false, "normal");
        out.push(ruleText(line.style, receipt.width), "\n");
        break;
      case "feed":
        out.push("\n".repeat(line.lines));
        break;
    }
  }
  style("left", false, "normal");
  out.push(FEED_AND_CUT);
  return out.join("");
}

function pad(value: string, align: "left" | "center" | "right", columns: number): string {
  if (align === "left" || value.length >= columns) return value;
  const space = columns - value.length;
  return align === "right" ? " ".repeat(space) + value : " ".repeat(Math.floor(space / 2)) + value;
}

/** Plain text for on-screen preview; emphasis cannot be shown, layout can. */
export function encodeReceiptPlain(receipt: RenderedReceiptLines): string {
  const out: string[] = [];
  for (const line of receipt.lines as readonly ReceiptLine[]) {
    switch (line.kind) {
      case "text":
        out.push(pad(" ".repeat(line.indent ?? 0) + printable(line.text), line.align, columnsFor(receipt.width, line.size)));
        break;
      case "columns":
        out.push(justify(printable(line.left), printable(line.right), columnsFor(receipt.width, line.size)));
        break;
      case "rule":
        out.push(ruleText(line.style, receipt.width));
        break;
      case "feed":
        for (let i = 0; i < line.lines; i++) out.push("");
        break;
    }
  }
  return out.join("\n");
}
