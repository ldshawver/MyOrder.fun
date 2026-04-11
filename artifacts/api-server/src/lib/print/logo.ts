import { centerText } from "./formatter";

const PRIMARY_WIDE   = "A   L   A   V   O   N   T";   // 21 chars — elegant on 80mm
const TAGLINE_WIDE   = "T H E R A P E U T I C S";     // 23 chars
const PRIMARY_NARROW = "A L A V O N T";               // 13 chars — compact on 58mm
const TAGLINE_NARROW = "THERAPEUTICS";                // 12 chars

/**
 * Returns centered Alavont Therapeutics logo lines for the given paper width.
 * Dual-brand lines are NOT included here — the receipt template adds them separately
 * via the `dualBrandName` field so they can be positioned correctly in the layout.
 *
 * @param width Char width of the paper (32 = 58mm, 48 = 80mm).
 */
export function getLogo(width: number): string[] {
  if (width >= 40) {
    return [
      centerText(PRIMARY_WIDE, width),
      centerText(TAGLINE_WIDE, width),
    ];
  }
  return [
    centerText(PRIMARY_NARROW, width),
    centerText(TAGLINE_NARROW, width),
  ];
}

/** Returns the primary brand name for fallback text usage. */
export function getPrimaryBrandName(): string {
  return "ALAVONT THERAPEUTICS";
}
