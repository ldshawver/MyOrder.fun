import { centerText } from "./formatter";

const PRIMARY = "MYORDER.FUN";

/**
 * Returns a clean centered text logo for thermal receipt printers.
 *
 * The previous ASCII-art mark was hard to read on small thermal paper. The
 * app still shows the full image asset in the admin preview, but receipt text
 * output uses this simple high-legibility wordmark so it prints cleanly on
 * both 58mm and 80mm printers.
 */
export function getLogo(width: number, primary = PRIMARY): string[] {
  // Keep the receipt header to a single line. The previous two-line mark
  // consumed enough vertical space to be clipped by some thermal printers.
  return [centerText(primary, width)];
}

/** Returns the primary brand name for fallback text usage. */
export function getPrimaryBrandName(): string {
  return "MYORDER.FUN";
}
