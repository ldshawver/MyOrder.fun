import type { PrintBlock } from "../renderer";
import { formatDate, money } from "../formatter";

export interface InventoryEndItem {
  rowType: string;
  sectionName?: string | null;
  itemName: string;
  unitType?: string | null;
  quantityStart: number | string;
  quantitySold?: number | string | null;
  quantityEnd?: number | string | null;
  unitPrice?: number | string | null;
  isFlagged?: boolean | null;
}

export interface InventoryEndData {
  shiftId: number | string;
  operatorName?: string | null;
  clockedInAt?: string | Date | null;
  clockedOutAt?: string | Date | null;
  tenantName?: string | null;
  items: InventoryEndItem[];
  totalSales?: number | string | null;
  pettyCash?: number | string | null;
  notes?: string | null;
  logoLines?: string[];
  footerMessage?: string | null;
}

export function buildInventoryEndBlocks(data: InventoryEndData): PrintBlock[] {
  const blocks: PrintBlock[] = [];

  // ── Header ───────────────────────────────────────────────────────────────────
  if (data.logoLines?.length) {
    blocks.push({ type: "logo", lines: data.logoLines });
    blocks.push({ type: "spacer" });
  }

  blocks.push({ type: "divider", char: "=" });
  blocks.push({ type: "center", text: "ENDING INVENTORY" });
  blocks.push({ type: "center", text: "CLOCK-OUT RECORD" });
  blocks.push({ type: "divider", char: "=" });

  blocks.push({ type: "kv", left: "Shift #:", right: String(data.shiftId) });
  blocks.push({ type: "kv", left: "Clock In:", right: formatDate(data.clockedInAt) });
  blocks.push({ type: "kv", left: "Clock Out:", right: formatDate(data.clockedOutAt) });
  if (data.operatorName) {
    blocks.push({ type: "kv", left: "Operator:", right: data.operatorName });
  }
  if (data.tenantName) {
    blocks.push({ type: "kv", left: "Location:", right: data.tenantName });
  }

  // ── Column Header ─────────────────────────────────────────────────────────────
  blocks.push({ type: "divider", char: "-" });
  blocks.push({
    type: "text",
    text: "ITEM                  START SOLD  END",
  });
  blocks.push({ type: "divider", char: "-" });

  // ── Inventory Rows ────────────────────────────────────────────────────────────
  let hasFlagged = false;
  for (const item of data.items ?? []) {
    if (item.rowType === "section") {
      blocks.push({ type: "spacer" });
      blocks.push({ type: "section", text: item.sectionName ?? item.itemName });
      continue;
    }
    if (item.rowType === "spacer") {
      blocks.push({ type: "spacer" });
      continue;
    }

    const start = Number(item.quantityStart ?? 0);
    const sold = Number(item.quantitySold ?? 0);
    const end = item.quantityEnd !== null && item.quantityEnd !== undefined
      ? Number(item.quantityEnd)
      : start - sold;
    const unit = item.unitType ?? "#";

    const fmt = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(1);

    const name = item.itemName.length > 20
      ? item.itemName.slice(0, 19) + "…"
      : item.itemName.padEnd(20);

    const flag = item.isFlagged ? " !" : "  ";
    if (item.isFlagged) hasFlagged = true;

    blocks.push({
      type: "text",
      text: `${name} ${fmt(start).padStart(5)} ${fmt(sold).padStart(4)} ${fmt(end).padStart(4)}${flag}`,
    });
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  blocks.push({ type: "divider", char: "=" });

  if (hasFlagged) {
    blocks.push({ type: "text", text: "! = Negative ending quantity" });
    blocks.push({ type: "divider", char: "-" });
  }

  if (data.totalSales !== null && data.totalSales !== undefined) {
    blocks.push({ type: "kv", left: "Total Sales:", right: money(data.totalSales) });
  }
  if (data.pettyCash !== null && data.pettyCash !== undefined) {
    blocks.push({ type: "kv", left: "Petty Cash:", right: money(data.pettyCash) });
  }

  // ── Notes ────────────────────────────────────────────────────────────────────
  if (data.notes) {
    blocks.push({ type: "divider", char: "-" });
    blocks.push({ type: "text", text: "Notes:" });
    blocks.push({ type: "wrap", text: data.notes });
  }

  // ── Discrepancy Area ─────────────────────────────────────────────────────────
  blocks.push({ type: "spacer", count: 2 });
  blocks.push({ type: "divider", char: "-" });
  blocks.push({ type: "text", text: "Discrepancy notes:" });
  blocks.push({ type: "spacer", count: 2 });
  blocks.push({ type: "text", text: "_________________________________" });
  blocks.push({ type: "spacer" });
  blocks.push({ type: "text", text: "Verified by: ___________________" });
  blocks.push({ type: "spacer" });
  blocks.push({ type: "text", text: "Signature: ____________________" });
  blocks.push({ type: "divider", char: "=" });

  if (data.footerMessage) {
    blocks.push({ type: "spacer" });
    blocks.push({ type: "center", text: data.footerMessage });
  }

  blocks.push({ type: "spacer", count: 2 });
  return blocks;
}
