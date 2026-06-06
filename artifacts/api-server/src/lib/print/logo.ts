import { centerText } from "./formatter";

const PRIMARY = "ALAVONT";
const TAGLINE = "THERAPEUTICS";

/**
 * Returns a clean centered text logo for thermal receipt printers.
 *
 * The previous ASCII-art mark was hard to read on small thermal paper. The
 * app still shows the full image asset in the admin preview, but receipt text
 * output uses this simple high-legibility wordmark so it prints cleanly on
 * both 58mm and 80mm printers.
 */
export function getLogo(width: number): string[] {
  return [
    centerText(PRIMARY, width),
    centerText(TAGLINE, width),
  ];
}

/** Returns the primary brand name for fallback text usage. */
export function getPrimaryBrandName(): string {
  return "ALAVONT THERAPEUTICS";
}
