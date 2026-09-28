/** "58mm" is the legacy spelling of the narrow (50mm class) roll. */
export type PaperWidth = "50mm" | "58mm" | "80mm";

export const CHAR_WIDTHS: Record<PaperWidth, number> = {
  "50mm": 32,
  "58mm": 32,
  "80mm": 48,
};

export function charWidth(paper: string | null | undefined): number {
  return CHAR_WIDTHS[(paper ?? "80mm") as PaperWidth] ?? 48;
}
