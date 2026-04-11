import {
  centerText,
  divider,
  kvLine,
  wrapText,
  itemLine,
  receiptItemLine,
  receiptItemColHeader,
  receiptTotalLine,
} from "./formatter";

export type PrintBlock =
  | { type: "logo";        lines: string[] }
  | { type: "center";      text: string }
  | { type: "text";        text: string }
  | { type: "divider";     char?: string }
  | { type: "kv";          left: string; right: string }
  | { type: "itemRow";     name: string; qty: number | string; unitPrice: number | string; total: number | string }
  | { type: "receiptItem"; name: string; qty: number | string; total: number | string; notes?: string | null }
  | { type: "totalLine";   label: string; amount: number | string; strong?: boolean }
  | { type: "colHeader" }
  | { type: "spacer";      count?: number }
  | { type: "section";     text: string }
  | { type: "wrap";        text: string };

export function renderBlocks(blocks: PrintBlock[], width: number): string {
  const lines: string[] = [];

  for (const block of blocks) {
    switch (block.type) {

      case "logo":
        for (const l of block.lines) lines.push(centerText(l, width));
        break;

      case "center":
        lines.push(centerText(block.text, width));
        break;

      case "text":
        lines.push(block.text);
        break;

      case "divider":
        lines.push(divider(width, block.char ?? "="));
        break;

      case "kv":
        lines.push(kvLine(block.left, block.right, width));
        break;

      case "itemRow":
        for (const l of itemLine(block.name, block.qty, block.unitPrice, block.total, width)) {
          lines.push(l);
        }
        break;

      case "receiptItem": {
        for (const l of receiptItemLine(block.name, block.qty, block.total, width)) {
          lines.push(l);
        }
        if (block.notes) {
          // Indented note line (7 = 2 margin + 3 qty + 2 gap)
          lines.push(" ".repeat(7) + "* " + block.notes);
        }
        break;
      }

      case "totalLine":
        lines.push(receiptTotalLine(block.label, block.amount, width, block.strong));
        break;

      case "colHeader":
        lines.push(receiptItemColHeader(width));
        break;

      case "spacer":
        for (let i = 0; i < (block.count ?? 1); i++) lines.push("");
        break;

      case "section":
        lines.push(divider(width, "-"));
        lines.push(centerText(block.text.toUpperCase(), width));
        lines.push(divider(width, "-"));
        break;

      case "wrap":
        for (const l of wrapText(block.text, width)) lines.push(l);
        break;
    }
  }

  // Paper feed
  lines.push("", "");
  return lines.join("\n");
}
