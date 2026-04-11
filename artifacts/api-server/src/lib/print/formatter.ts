// ── Text helpers ─────────────────────────────────────────────────────────────

export function centerText(text: string, width: number): string {
  const s = String(text ?? "");
  if (s.length >= width) return s.slice(0, width);
  const pad = Math.floor((width - s.length) / 2);
  return " ".repeat(pad) + s;
}

export function rightAlign(text: string, width: number): string {
  const s = String(text ?? "");
  if (s.length >= width) return s.slice(0, width);
  return " ".repeat(width - s.length) + s;
}

export function divider(width: number, char = "="): string {
  return char.repeat(width);
}

export function kvLine(left: string, right: string, width: number): string {
  const l = String(left ?? "");
  const r = String(right ?? "");
  const gap = width - l.length - r.length;
  if (gap <= 0) return (l + " " + r).slice(0, width);
  return l + " ".repeat(gap) + r;
}

export function wrapText(text: string, width: number): string[] {
  const words = String(text ?? "").split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += " " + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

export function spacedText(text: string, sep = "  "): string {
  return String(text ?? "").toUpperCase().split("").join(sep);
}

// ── Receipt-specific formatters ───────────────────────────────────────────────

const RECEIPT_MARGIN  = 2;
const RECEIPT_QTY_W   = 3;
const RECEIPT_GAP     = 2;
const RECEIPT_TOTAL_W = 9;
const RECEIPT_OFFSET  = RECEIPT_MARGIN + RECEIPT_QTY_W + RECEIPT_GAP; // 7

export function receiptNameWidth(width: number): number {
  return Math.max(4, width - RECEIPT_OFFSET - RECEIPT_TOTAL_W);
}

export function receiptItemColHeader(width: number): string {
  const nw = receiptNameWidth(width);
  const left  = " ".repeat(RECEIPT_MARGIN) + "QTY".padStart(RECEIPT_QTY_W) + " ".repeat(RECEIPT_GAP);
  const right = "TOTAL".padStart(RECEIPT_TOTAL_W);
  return left + "ITEM".padEnd(nw) + right;
}

export function receiptItemLine(
  name: string,
  qty: number | string,
  total: number | string,
  width: number
): string[] {
  const nw = receiptNameWidth(width);
  const qtyVal = Number(qty ?? 1);
  const qtyStr = (Number.isInteger(qtyVal) ? String(qtyVal) : qtyVal.toFixed(1)).padStart(RECEIPT_QTY_W);
  const totalStr = `$${Number(total ?? 0).toFixed(2)}`.padStart(RECEIPT_TOTAL_W);
  const prefix = " ".repeat(RECEIPT_MARGIN) + qtyStr + " ".repeat(RECEIPT_GAP);
  const indent = " ".repeat(RECEIPT_OFFSET);
  const nameStr = String(name ?? "");

  if (nameStr.length <= nw) {
    return [prefix + nameStr.padEnd(nw) + totalStr];
  }

  // Break at word boundary when possible — avoids ugly mid-word splits
  let breakAt = nw;
  if (nameStr[nw] !== " " && nameStr[nw - 1] !== " ") {
    const lastSpace = nameStr.lastIndexOf(" ", nw - 1);
    if (lastSpace > nw / 2) breakAt = lastSpace; // only use word break if not too far back
  }

  const lines: string[] = [];
  lines.push(prefix + nameStr.slice(0, breakAt).padEnd(nw) + totalStr);
  const rest = wrapText(nameStr.slice(breakAt).trimStart(), width - RECEIPT_OFFSET);
  for (const l of rest) lines.push(indent + l);
  return lines;
}

export function receiptTotalLine(
  label: string,
  amount: number | string,
  width: number,
  strong = false
): string {
  const labelStr = " ".repeat(RECEIPT_MARGIN) + (strong ? label.toUpperCase() : label);
  const amtStr = `$${Number(amount ?? 0).toFixed(2)}`.padStart(RECEIPT_TOTAL_W);
  const gap = width - labelStr.length - RECEIPT_TOTAL_W;
  if (gap <= 0) return (labelStr + " " + amtStr.trim()).slice(0, width);
  return labelStr + " ".repeat(gap) + amtStr;
}

// ── Old item line (kept for inventory/label templates) ───────────────────────

export function itemLine(
  name: string,
  qty: number | string,
  unitPrice: number | string,
  total: number | string,
  width: number
): string[] {
  const qtyStr = String(qty);
  const totalStr = `$${Number(total ?? 0).toFixed(2)}`;
  const unitStr  = `$${Number(unitPrice ?? 0).toFixed(2)}`;
  const prefix = `${qtyStr} x `;
  const suffix = ` ${unitStr}  ${totalStr}`;
  const nameWidth = width - prefix.length - suffix.length;
  const nameStr = String(name ?? "");

  if (nameStr.length <= nameWidth) {
    return [prefix + nameStr + " ".repeat(Math.max(0, nameWidth - nameStr.length)) + suffix];
  }
  const firstLine = prefix + nameStr.slice(0, nameWidth) + suffix;
  const indent = " ".repeat(prefix.length);
  const wrapped = wrapText(nameStr.slice(nameWidth), width - indent.length).map(l => indent + l);
  return [firstLine, ...wrapped];
}

export function fitLogo(logoText: string, width: number): string[] {
  return logoText.split("\n").map(line => (line.length <= width ? line : line.slice(0, width)));
}

// ── Money / date ─────────────────────────────────────────────────────────────

export function money(n: number | string | null | undefined): string {
  return `$${Number(n ?? 0).toFixed(2)}`;
}

export function formatDate(d: string | Date | null | undefined): string {
  if (!d) return "";
  return new Date(d).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export function formatReceiptDate(d: string | Date | null | undefined): string {
  if (!d) return "";
  return new Date(d).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

export function formatShortDate(d: string | Date | null | undefined): string {
  if (!d) return "";
  return new Date(d).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}
