import type { PrintBlock } from "../renderer";
import { formatDate } from "../formatter";

export interface InventoryStartItem {
  rowType: string;
  sectionName?: string | null;
  itemName: string;
  unitType?: string | null;
  quantityStart: number | string;
}

export interface InventoryStartData {
  shiftId: number | string;
  operatorName?: string | null;
  clockedInAt?: string | Date | null;
  tenantName?: string | null;
  items: InventoryStartItem[];
  logoLines?: string[];
  footerMessage?: string | null;
}

export function buildInventoryStartBlocks(data: InventoryStartData): PrintBlock[] {
  const blocks: PrintBlock[] = [];

  // ── Header ───────────────────────────────────────────────────────────────────
  if (data.logoLines?.length) {
    blocks.push({ type: "logo", lines: data.logoLines });
    blocks.push({ type: "spacer" });
  }

  blocks.push({ type: "divider", char: "=" });
  blocks.push({ type: "center", text: "STARTING INVENTORY" });
  blocks.push({ type: "center", text: "CLOCK-IN RECORD" });
  blocks.push({ type: "divider", char: "=" });

  blocks.push({ type: "kv", left: "Shift #:", right: String(data.shiftId) });
  blocks.push({ type: "kv", left: "Date:", right: formatDate(data.clockedInAt) });
  if (data.operatorName) {
    blocks.push({ type: "kv", left: "Operator:", right: data.operatorName });
  }
  if (data.tenantName) {
    blocks.push({ type: "kv", left: "Location:", right: data.tenantName });
  }
  blocks.push({ type: "divider", char: "-" });

  // ── Inventory Rows ────────────────────────────────────────────────────────────
  let currentSection = "";
  for (const item of data.items ?? []) {
    if (item.rowType === "section") {
      currentSection = item.sectionName ?? item.itemName;
      blocks.push({ type: "spacer" });
      blocks.push({ type: "section", text: currentSection });
      continue;
    }
    if (item.rowType === "spacer") {
      blocks.push({ type: "spacer" });
      continue;
    }

    const qty = Number(item.quantityStart ?? 0);
    const unit = item.unitType ?? "#";
    const qtyStr = Number.isInteger(qty) ? String(qty) : qty.toFixed(3).replace(/\.?0+$/, "");
    blocks.push({
      type: "kv",
      left: `  ${item.itemName}`,
      right: `${qtyStr} ${unit}`,
    });
  }

  // ── Signature Area ────────────────────────────────────────────────────────────
  blocks.push({ type: "spacer", count: 2 });
  blocks.push({ type: "divider", char: "-" });
  blocks.push({ type: "text", text: "Verified by: ___________________" });
  blocks.push({ type: "spacer" });
  blocks.push({ type: "text", text: "Signature: ____________________" });
  blocks.push({ type: "spacer" });
  blocks.push({ type: "text", text: "Date/Time: ____________________" });
  blocks.push({ type: "divider", char: "=" });

  if (data.footerMessage) {
    blocks.push({ type: "spacer" });
    blocks.push({ type: "center", text: data.footerMessage });
  }

  blocks.push({ type: "spacer", count: 2 });
  return blocks;
}
