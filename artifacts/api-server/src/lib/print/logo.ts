import { centerText } from "./formatter";

const MARK_WIDE = [
  "          /\\",
  "         /  \\",
  "        / /\\ \\",
  "       / ____ \\",
  "      /_/    \\_\\",
];
const MARK_NARROW = [
  "    /\\",
  "   /  \\",
  "  / /\\ \\",
  " /_/  \\_\\",
];

const PRIMARY_WIDE = "ALAVONT";
const TAGLINE_WIDE = "THERAPEUTICS";
const PRIMARY_NARROW = "ALAVONT";
const TAGLINE_NARROW = "THERAPEUTICS";

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
      ...MARK_WIDE.map(line => centerText(line, width)),
      centerText(PRIMARY_WIDE, width),
      centerText(TAGLINE_WIDE, width),
    ];
  }
  return [
    ...MARK_NARROW.map(line => centerText(line, width)),
    centerText(PRIMARY_NARROW, width),
    centerText(TAGLINE_NARROW, width),
  ];
}

/** Returns the primary brand name for fallback text usage. */
export function getPrimaryBrandName(): string {
  return "ALAVONT THERAPEUTICS";
}
