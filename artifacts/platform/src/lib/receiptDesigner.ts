/**
 * Receipt designer model. The designer edits a list of blocks and saves them
 * as the server's strict receipt template layout. It never invents fields:
 * data fields come from /api/print/templates/receipt-fields, and the server
 * validates every layout again on save and preview.
 */

export type BlockAlign = "left" | "center" | "right";
export type BlockSize = "normal" | "tall" | "large";
export type SeparatorStyle = "solid" | "dashed" | "double";
export type ItemOption = "showOption" | "showSku" | "showUnitPrice" | "showItemNotes";

interface BlockCommon {
  id: string;
  enabled: boolean;
  /** Blank lines before/after (0-4); stored as points (12pt per line). */
  spaceBefore: number;
  spaceAfter: number;
}

export type DesignerBlock =
  | (BlockCommon & { kind: "data"; field: string; label: string; align: BlockAlign; bold: boolean; size: BlockSize; itemOptions: Partial<Record<ItemOption, boolean>> })
  | (BlockCommon & { kind: "text"; text: string; align: BlockAlign; bold: boolean; size: BlockSize })
  | (BlockCommon & { kind: "separator"; style: SeparatorStyle });

/** Printer text sizes map onto the schema's fontSize (server: >=17 tall, >=32 large). */
export const SIZE_FONT: Record<BlockSize, number> = { normal: 12, tall: 20, large: 36 };
export function sizeFromFont(fontSize: unknown): BlockSize {
  const size = Number(fontSize);
  if (size >= 32) return "large";
  if (size >= 17) return "tall";
  return "normal";
}

export const MAX_BLOCKS = 100;
export const MAX_TEXT = 500;
export const MAX_LABEL = 80;
/** Control and format characters the server rejects in template text. */
const UNSAFE_TEXT = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(31) + String.fromCharCode(127) + "-" + String.fromCharCode(159) + "]|\\p{Cf}", "u");

export function textProblem(value: string, max: number): string | null {
  if (value.length > max) return `Keep this under ${max} characters`;
  if (UNSAFE_TEXT.test(value)) return "Remove special control characters";
  return null;
}

let counter = 0;
export function newBlockId(prefix: string, taken: ReadonlySet<string>): string {
  let id: string;
  do { id = `${prefix}-${(++counter).toString(36)}`; } while (taken.has(id));
  return id;
}

const lines = (points: unknown) => Math.max(0, Math.min(4, Math.round(Number(points ?? 0) / 12)));

export function makeBlock(kind: "data" | "text" | "separator", taken: ReadonlySet<string>, field = "orderNumber"): DesignerBlock {
  const base = { id: newBlockId(kind, taken), enabled: true, spaceBefore: 0, spaceAfter: 0 };
  if (kind === "separator") return { ...base, kind, style: "dashed" };
  if (kind === "text") return { ...base, kind, text: "Thank you!", align: "center", bold: false, size: "normal" };
  return { ...base, kind, field, label: "", align: "left", bold: false, size: "normal", itemOptions: {} };
}

/** Designer blocks → the server's strict layout (only known keys). */
export function toLayout(blocks: readonly DesignerBlock[]): Array<Record<string, unknown>> {
  return blocks.map((block) => {
    const spacing = { spacingBefore: block.spaceBefore * 12, spacingAfter: block.spaceAfter * 12 };
    if (block.kind === "separator") return { type: "separator", id: block.id, enabled: block.enabled, style: block.style, ...spacing };
    const common = { id: block.id, enabled: block.enabled, align: block.align, bold: block.bold, fontSize: SIZE_FONT[block.size], ...spacing };
    if (block.kind === "text") return { type: "customText", ...common, text: block.text };
    const options = block.field === "items"
      ? Object.fromEntries(Object.entries(block.itemOptions).filter(([, value]) => typeof value === "boolean"))
      : {};
    return { type: "data", ...common, field: block.field, ...(block.label.trim() ? { label: block.label.trim() } : {}), ...options };
  });
}

/** Stored layout → designer blocks. Unknown block types are dropped (the server never stores them). */
export function fromLayout(layout: unknown): DesignerBlock[] {
  if (!Array.isArray(layout)) return [];
  return layout.flatMap((raw): DesignerBlock[] => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const common = {
      id: String(item.id ?? ""), enabled: item.enabled !== false,
      spaceBefore: lines(item.spacingBefore), spaceAfter: lines(item.spacingAfter),
    };
    if (!common.id) return [];
    if (item.type === "separator") {
      const style = item.style === "solid" || item.style === "double" ? item.style : "dashed";
      return [{ ...common, kind: "separator", style }];
    }
    const style = {
      align: (item.align === "center" || item.align === "right" ? item.align : "left") as BlockAlign,
      bold: item.bold === true,
      size: sizeFromFont(item.fontSize),
    };
    if (item.type === "customText") return [{ ...common, kind: "text", text: String(item.text ?? ""), ...style }];
    if (item.type === "data") {
      const itemOptions: Partial<Record<ItemOption, boolean>> = {};
      for (const option of ["showOption", "showSku", "showUnitPrice", "showItemNotes"] as const) {
        if (typeof item[option] === "boolean") itemOptions[option] = item[option] as boolean;
      }
      return [{ ...common, kind: "data", field: String(item.field ?? ""), label: String(item.label ?? ""), ...style, itemOptions }];
    }
    return [];
  });
}

export function moveBlock<T>(blocks: readonly T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (target < 0 || target >= blocks.length) return [...blocks];
  const next = [...blocks];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** A sensible starting receipt using only standard fields. */
export function defaultBlocks(): DesignerBlock[] {
  const taken = new Set<string>();
  const add = (block: DesignerBlock) => { taken.add(block.id); return block; };
  const data = (field: string, patch: Partial<Extract<DesignerBlock, { kind: "data" }>> = {}) =>
    add({ ...(makeBlock("data", taken, field) as Extract<DesignerBlock, { kind: "data" }>), ...patch });
  const sep = (style: SeparatorStyle) => add({ ...(makeBlock("separator", taken) as Extract<DesignerBlock, { kind: "separator" }>), style });
  return [
    data("businessName", { align: "center", bold: true, size: "tall" }),
    data("businessAddress", { align: "center" }),
    data("businessPhone", { align: "center" }),
    sep("dashed"),
    data("orderNumber"),
    data("dateTime"),
    data("csr"),
    sep("dashed"),
    data("items", { itemOptions: { showOption: true } }),
    sep("dashed"),
    data("subtotal"),
    data("discounts"),
    data("salesTax"),
    data("total", { bold: true }),
    data("tenderType", { spaceBefore: 1 }),
    data("cashReceived"),
    data("change"),
    sep("dashed"),
    data("thankYou", { align: "center", spaceBefore: 1 }),
  ];
}
