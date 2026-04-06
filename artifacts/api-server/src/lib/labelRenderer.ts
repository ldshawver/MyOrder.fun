/**
 * labelRenderer.ts — Render label print jobs.
 *
 * Produces ESC/POS text for plain-text labels.
 * PNG overlay rendering requires 'sharp' to be installed; if not present,
 * falls back to text-only output.
 */

export type LabelField = {
  key: string;
  x?: number;
  y?: number;
  fontSize?: number;
  fontWeight?: "normal" | "bold";
  align?: "left" | "center" | "right";
  maxWidth?: number;
  label?: string; // optional header text before value
};

export type LabelTemplate = {
  name: string;
  paperWidth?: string;
  fields: LabelField[];
  backgroundImagePath?: string; // absolute path to PNG asset
};

export type LabelData = Record<string, string | number | undefined | null>;

/**
 * Render a text-mode label (ESC/POS compatible).
 * Used when bridge only supports raw text or when PNG rendering unavailable.
 */
export function renderTextLabel(template: LabelTemplate, data: LabelData): string {
  const width = template.paperWidth === "58mm" ? 32 : 48;
  const separator = "─".repeat(width);
  const lines: string[] = [];

  lines.push("", separator);
  lines.push(centerPad(template.name.toUpperCase(), width));
  lines.push(separator);

  for (const field of template.fields) {
    const raw = data[field.key];
    if (raw === undefined || raw === null) continue;
    const value = String(raw);
    const header = field.label ? `${field.label}: ` : "";

    if (field.fontWeight === "bold" || field.fontSize && field.fontSize >= 16) {
      // Bold emphasis for large fields
      lines.push("");
      lines.push(centerPad((header + value).toUpperCase(), width));
    } else if (field.align === "center") {
      lines.push(centerPad(header + value, width));
    } else {
      lines.push(header + value);
    }
  }

  lines.push(separator, "");
  return lines.join("\n");
}

/**
 * Render a PNG label with background image + text overlay.
 * Returns a Buffer (PNG) or null if sharp is not available.
 */
export async function renderPngLabel(
  template: LabelTemplate,
  data: LabelData
): Promise<Buffer | null> {
  let sharp: typeof import("sharp") | null = null;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    return null;
  }

  // Paper dimensions in pixels at 203 DPI (standard thermal)
  const mmToPx = (mm: number) => Math.round((mm / 25.4) * 203);
  const widthMm = parseInt((template.paperWidth ?? "58mm").replace("mm", ""), 10) || 58;
  const widthPx = mmToPx(widthMm);
  const heightPx = 400; // default; templates can override

  // Build SVG overlay for text fields
  const svgParts: string[] = [];
  for (const field of template.fields) {
    const raw = data[field.key];
    if (raw === undefined || raw === null) continue;

    const value = String(raw);
    const x = field.x ?? widthPx / 2;
    const y = field.y ?? 40;
    const fontSize = field.fontSize ?? 14;
    const fontWeight = field.fontWeight ?? "normal";
    const anchor = field.align === "right" ? "end" : field.align === "center" ? "middle" : "start";

    const escaped = value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    svgParts.push(
      `<text x="${x}" y="${y}" font-size="${fontSize}" font-weight="${fontWeight}" text-anchor="${anchor}" font-family="monospace" fill="black">${escaped}</text>`
    );
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPx}" height="${heightPx}">${svgParts.join("")}</svg>`;
  const svgBuf = Buffer.from(svg);

  try {
    if (template.backgroundImagePath) {
      const result = await sharp(template.backgroundImagePath)
        .resize(widthPx, heightPx, { fit: "fill" })
        .composite([{ input: svgBuf, top: 0, left: 0 }])
        .png()
        .toBuffer();
      return result;
    } else {
      // White background
      const result = await sharp({
        create: { width: widthPx, height: heightPx, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
      })
        .composite([{ input: svgBuf, top: 0, left: 0 }])
        .png()
        .toBuffer();
      return result;
    }
  } catch {
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function centerPad(text: string, width: number): string {
  if (text.length >= width) return text;
  const pad = Math.floor((width - text.length) / 2);
  return " ".repeat(pad) + text;
}
