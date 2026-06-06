/**
 * thankYouLabel.ts — Server-side image composition for the personalized
 * circular "Thank You" sticker label (2" × 2", 203 DPI → 406 × 406 px).
 *
 * Sticker artwork structure (from pixel analysis):
 *   • y=21–66  (orig)  → TOP ARCH  — opaque black arc
 *   • y=78–87  (orig)  → "Thank You" text — opaque black characters
 *   • y=90–111 (orig)  → CLEAR ZONE (transparent) ← customer name goes here
 *   • y=114–155 (orig) → BOTTOM CURVE ("LuciferCruz.com") — opaque black
 *
 * Composition order (sharp):
 *   1. Solid white background (406 × 406)
 *   2. Customer name SVG (dark ink, centered in the clear zone)
 *   3. Sticker PNG on top — transparent areas reveal the name below
 *
 * Clear zone in 406px canvas:
 *   y = 183–225  (= orig 90–111 × 2.03 scale factor)
 *   Safe text baseline: NAME_Y = 218
 *   Max font cap-height: ~26px → max font-size ≈ 36px
 */

import path from "path";

// ── Canvas / print dimensions ─────────────────────────────────────────────────
export const LABEL_W = 406;   // 2" at 203 DPI
export const LABEL_H = 406;

// ── Locked text coordinates (relative to 406 × 406 canvas) ───────────────────
// Clear zone in 406px canvas: y ≈ 183–225 px  (orig y=90–111 × 2.03 scale).
// NAME_X shifted 22px right of center to clear the inner left "C" arc element
// which extends to x≈152 at the baseline rows.
export const NAME_X   = 225;  // right-shifted to clear left arc
export const NAME_Y   = 214;  // text baseline — safely inside the clear zone

// ── Font settings ─────────────────────────────────────────────────────────────
export const TEXT_COLOR   = "#111111";   // dark ink (visible on white paper)
export const FONT_FAMILY  = "Arial, Liberation Sans, DejaVu Sans, Sans";

// ── Length-based font-size ladder ─────────────────────────────────────────────
// All sizes tuned so the name stays inside the ≈40px-tall clear zone and
// doesn't extend left into the sticker's "C" curl opaque region.
export const FONT_LADDER: { maxLen: number; size: number }[] = [
  { maxLen:  6, size: 34 },
  { maxLen:  9, size: 28 },
  { maxLen: 13, size: 22 },
  { maxLen: 17, size: 18 },
  { maxLen: 20, size: 15 },
];

export const MIN_FONT_SIZE = 13;

// ── Base asset path ───────────────────────────────────────────────────────────
// At runtime, import.meta.dirname resolves to the dist/ directory.
// build.mjs copies src/lib/print/assets/ → dist/assets/ so this path is stable
// in both development (after build) and production.
const BASE_PNG = path.join(
  import.meta.dirname,
  "assets",
  "Thank-You-Sticker-Personalized.png"
);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Pick font size for the given name string. */
export function pickFontSize(name: string): number {
  for (const { maxLen, size } of FONT_LADDER) {
    if (name.length <= maxLen) return size;
  }
  return MIN_FONT_SIZE;
}

/** Sanitize customer name — remove control chars, truncate to 20. */
export function sanitizeName(raw: string): string {
  const cleaned = raw.trim().replace(/[^\w\s''.-]/g, "");
  return cleaned.slice(0, 20) || "Friend";
}

/** Escape XML special characters for safe SVG embedding. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Build the SVG name overlay for a given name + font size. */
export function buildNameOverlaySvg(name: string, fontSize: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${LABEL_W}" height="${LABEL_H}">
  <text
    x="${NAME_X}"
    y="${NAME_Y}"
    font-size="${fontSize}"
    font-weight="bold"
    font-family="${FONT_FAMILY}"
    text-anchor="middle"
    dominant-baseline="auto"
    fill="${TEXT_COLOR}"
    letter-spacing="1"
  >${escapeXml(name)}</text>
</svg>`;
}

// ── Main exports ──────────────────────────────────────────────────────────────

/**
 * Generate a personalized Thank You label as a PNG Buffer.
 *
 * Composition:
 *   [white bg] → [name text] → [sticker PNG on top]
 * The sticker's transparent interior reveals the name below.
 *
 * @param customerFirstName  Customer's first name (raw; will be sanitized).
 * @returns PNG Buffer at LABEL_W × LABEL_H pixels.
 */
export async function generateThankYouLabel(customerFirstName: string): Promise<Buffer> {
  const sharp = (await import("sharp")).default;

  const name     = sanitizeName(customerFirstName);
  const fontSize = pickFontSize(name);
  const svg      = buildNameOverlaySvg(name, fontSize);
  const svgBuf   = Buffer.from(svg);

  // Resize the sticker to the canvas size first (native size is 200×200)
  const stickerBuf = await sharp(BASE_PNG)
    .resize(LABEL_W, LABEL_H, { fit: "fill" })
    .toBuffer();

  // 1. White background  →  2. Name text  →  3. Sticker on top
  // The sticker's transparent interior reveals the name text below.
  return sharp({
    create: {
      width:      LABEL_W,
      height:     LABEL_H,
      channels:   4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([
      { input: svgBuf,    top: 0, left: 0 },   // name text over white
      { input: stickerBuf, top: 0, left: 0 },  // sticker on top (scaled)
    ])
    .png()
    .toBuffer();
}

/**
 * Variant: generate without a specific name (uses "Friend" placeholder).
 * Useful for test prints and previewing the base design.
 */
export async function generateThankYouLabelTest(): Promise<Buffer> {
  return generateThankYouLabel("Friend");
}
