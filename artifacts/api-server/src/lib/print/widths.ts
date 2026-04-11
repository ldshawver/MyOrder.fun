export type PaperWidth = "58mm" | "80mm";

export const CHAR_WIDTHS: Record<PaperWidth, number> = {
  "58mm": 32,
  "80mm": 48,
};

export function charWidth(paper: string | null | undefined): number {
  return CHAR_WIDTHS[(paper ?? "80mm") as PaperWidth] ?? 48;
}
