import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const platformRoot = resolve(import.meta.dirname, "../../..");
const publicUrl = "/assets/media/happy-animated.gif";
const asset = resolve(platformRoot, `public${publicUrl}`);

function gifFrameCount(bytes: Buffer): number {
  let offset = 13;
  const packed = bytes[10];
  if (packed & 0x80) offset += 3 * (2 ** ((packed & 0x07) + 1));
  let frames = 0;
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      offset++;
      while (offset < bytes.length) { const size = bytes[offset++]; if (!size) break; offset += size; }
      continue;
    }
    if (marker !== 0x2c) throw new Error(`Unexpected GIF marker 0x${marker.toString(16)}`);
    frames++;
    offset += 8;
    const imagePacked = bytes[offset++];
    if (imagePacked & 0x80) offset += 3 * (2 ** ((imagePacked & 0x07) + 1));
    offset++;
    while (offset < bytes.length) { const size = bytes[offset++]; if (!size) break; offset += size; }
  }
  return frames;
}

describe("Happy animated asset", () => {
  it("uses a public /assets URL and preserves the authoritative animated GIF", () => {
    const source = readFileSync(resolve(platformRoot, "src/pages/ai-concierge.tsx"), "utf8");
    const bytes = readFileSync(asset);
    expect(source).toContain(`ZAPPY_HERO_IMAGE = "${publicUrl}"`);
    expect(source).not.toContain("/home/serveradmin/");
    expect(bytes.subarray(0, 6).toString("ascii")).toBe("GIF89a");
    expect(bytes.length).toBe(27_113_784);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("f4129ae658a46f9478c7b84fec228ea8d82162e7717bb263299605baefd7d041");
    expect(gifFrameCount(bytes)).toBe(417);
    expect(bytes.subarray(0, 20).toString("utf8")).not.toContain("<!DOCTYPE html>");
  });

  it("normalizes runtime asset permissions after the build copy", () => {
    const dockerfile = readFileSync(resolve(platformRoot, "../../deploy/Dockerfile.platform"), "utf8");
    expect(dockerfile).toContain("RUN chmod -R a+rX /usr/share/nginx/html");
  });
});
