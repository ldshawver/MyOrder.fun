import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

let root = "";
let store: typeof import("../profileImageStore");

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "myorder-profile-image-"));
  process.env.PROFILE_IMAGE_DIR = root;
  process.env.PROFILE_IMAGE_BINDING_KEY = "test-only-binding-key";
  store = await import("../profileImageStore");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  delete process.env.PROFILE_IMAGE_DIR;
  delete process.env.PROFILE_IMAGE_BINDING_KEY;
});

async function raster(format: "png" | "jpeg" | "webp") {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: "#b8002a" } })[format]().toBuffer();
}

describe("profile image storage", () => {
  it.each([
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
    ["webp", "image/webp"],
  ] as const)("accepts and safely re-encodes %s", async (format, mime) => {
    const id = await store.storeTemporaryProfileImage(await raster(format), mime, "member@example.com");
    await expect(store.assertTemporaryProfileImage(id, "member@example.com")).resolves.toBeUndefined();
    const output = await store.readProfileImage(id);
    expect(output?.subarray(0, 4).toString()).toBe("RIFF");
    await store.finalizeProfileImage(id);
    expect(await store.readProfileImage(id)).toEqual(output);
  });

  it("rejects missing, malformed, oversized, mismatched, and animated image content", async () => {
    await expect(store.sanitizeProfileImage(Buffer.from("not an image"), "image/png")).rejects.toThrow(/valid image/i);
    await expect(store.sanitizeProfileImage(await raster("png"), "image/jpeg")).rejects.toThrow(/PNG, JPEG, or WebP/i);
    await expect(store.sanitizeProfileImage(Buffer.alloc(3 * 1024 * 1024 + 1), "image/png")).rejects.toThrow(/3 MB/i);
    const gif = Buffer.from("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=", "base64");
    await expect(store.sanitizeProfileImage(gif, "image/gif")).rejects.toThrow(/PNG, JPEG, or WebP/i);
  });

  it("binds temporary uploads to the verified email and makes finalization retry-safe", async () => {
    const id = await store.storeTemporaryProfileImage(await raster("png"), "image/png", "member@example.com");
    await expect(store.assertTemporaryProfileImage(id, "other@example.com")).rejects.toThrow(/invalid or expired/i);
    await store.finalizeProfileImage(id);
    await expect(store.finalizeProfileImage(id)).resolves.toBeUndefined();
    await expect(store.assertTemporaryProfileImage(id, "member@example.com")).rejects.toThrow(/invalid or expired/i);
  });
});
