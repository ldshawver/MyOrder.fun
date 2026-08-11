import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  LABEL_H,
  LABEL_W,
  MIN_FONT_SIZE,
  generateThankYouLabel,
  pickFontSize,
  resolveLabelFirstName,
  sanitizeName,
} from "../print/templates/thankYouLabel";

describe("personalized thank-you label", () => {
  it.each(["Carlos", "Luke", "Jean-Luc", "María"])("preserves the first name %s", (name) => {
    expect(resolveLabelFirstName({ canonicalFirstName: name })).toBe(name);
    expect(sanitizeName(name)).toBe(name);
  });

  it("shrinks long names to a bounded legible minimum", () => {
    const name = "Alexanderthegreatest";
    expect(pickFontSize(name)).toBeGreaterThanOrEqual(MIN_FONT_SIZE);
    expect(sanitizeName(name)).toBe(name);
  });

  it("uses a validated full-name token and falls back safely", () => {
    expect(resolveLabelFirstName({ validatedFullName: "Carlos Rivera" })).toBe("Carlos");
    expect(resolveLabelFirstName({ canonicalFirstName: "", validatedFullName: "" })).toBe("Customer");
  });

  it.each([
    { canonicalFirstName: "person@example.com" },
    { canonicalFirstName: "+1 (555) 867-5309" },
    { validatedFullName: "person@example.com" },
    { validatedFullName: "555-867-5309" },
  ])("does not use email or phone contact values as names", (input) => {
    expect(resolveLabelFirstName(input)).toBe("Customer");
  });

  it("produces an opaque true-color black/white 406x406 raster with visible personalized ink", async () => {
    const png = await generateThankYouLabel("Carlos");
    const metadata = await sharp(png).metadata();
    expect(metadata).toMatchObject({ width: LABEL_W, height: LABEL_H, format: "png", hasAlpha: false });
    expect(metadata.isPalette).toBe(false);

    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    let black = 0;
    let white = 0;
    let nameZoneBlack = 0;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const value = data[(y * info.width + x) * info.channels];
        if (value === 0) {
          black++;
          if (y >= 180 && y <= 225) nameZoneBlack++;
        }
        if (value === 255) white++;
      }
    }
    expect(black).toBeGreaterThan(1000);
    expect(white).toBeGreaterThan(1000);
    expect(nameZoneBlack).toBeGreaterThan(50);
  });
});
