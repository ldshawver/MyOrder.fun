import type { PrintBlock } from "../renderer";
import { centerText, divider } from "../formatter";

export interface LabelData {
  title?: string | null;
  line1?: string | null;
  line2?: string | null;
  line3?: string | null;
  barcode?: string | null;
  footer?: string | null;
}

export function buildLabelBlocks(data: LabelData): PrintBlock[] {
  const blocks: PrintBlock[] = [];

  blocks.push({ type: "divider", char: "-" });

  if (data.title) {
    blocks.push({ type: "center", text: data.title.toUpperCase() });
    blocks.push({ type: "divider", char: "-" });
  }

  if (data.line1) blocks.push({ type: "center", text: data.line1 });
  if (data.line2) blocks.push({ type: "center", text: data.line2 });
  if (data.line3) blocks.push({ type: "center", text: data.line3 });

  if (data.barcode) {
    blocks.push({ type: "spacer" });
    blocks.push({ type: "center", text: `[${data.barcode}]` });
  }

  if (data.footer) {
    blocks.push({ type: "spacer" });
    blocks.push({ type: "center", text: data.footer });
  }

  blocks.push({ type: "divider", char: "-" });
  blocks.push({ type: "spacer" });
  return blocks;
}
