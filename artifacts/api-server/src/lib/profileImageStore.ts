import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";

const root = resolve(process.env.PROFILE_IMAGE_DIR ?? join(process.env.PRINT_ASSET_DIR ?? "/var/lib/myorder/print-assets", "profile-images"));
const staging = join(root, ".staging");
const TTL_MS = 2 * 60 * 60 * 1000;

async function ensureDirs() {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(staging, { recursive: true, mode: 0o700 });
}

function emailDigest(email: string) {
  const key = process.env.PROFILE_IMAGE_BINDING_KEY ?? process.env.CLERK_SECRET_KEY ?? "development-only-profile-image-binding";
  return createHmac("sha256", key).update(email.trim().toLowerCase()).digest("hex");
}

export async function sanitizeProfileImage(buffer: Buffer, declaredMime: string) {
  if (buffer.length > 3 * 1024 * 1024) throw new Error("Profile image must be no larger than 3 MB.");
  let image: sharp.Metadata;
  try { image = await sharp(buffer, { failOn: "error", limitInputPixels: 16_777_216 }).metadata(); }
  catch { throw new Error("The uploaded file is not a valid image."); }
  const detected: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
  if (!image.format || !detected[image.format] || detected[image.format] !== declaredMime || !image.width || !image.height || image.width > 4096 || image.height > 4096 || (image.pages ?? 1) > 1) {
    throw new Error("Use a non-animated PNG, JPEG, or WebP image no larger than 4096×4096 pixels.");
  }
  // Re-encoding removes metadata and any appended/polyglot payload. Only the
  // generated WebP output is stored or served, with a fixed image content type.
  return sharp(buffer, { failOn: "error", limitInputPixels: 16_777_216 })
    .rotate().resize(512, 512, { fit: "inside", withoutEnlargement: true }).webp({ quality: 84 }).toBuffer();
}

export async function storeTemporaryProfileImage(buffer: Buffer, mime: string, email: string) {
  await ensureDirs();
  const safeImage = await sanitizeProfileImage(buffer, mime);
  const id = randomUUID();
  try {
    await writeFile(join(staging, `${id}.meta`), JSON.stringify({ emailDigest: emailDigest(email), expiresAt: Date.now() + TTL_MS }), { flag: "wx", mode: 0o600 });
    await writeFile(join(staging, `${id}.webp`), safeImage, { flag: "wx", mode: 0o600 });
  } catch (err) {
    await Promise.all([unlink(join(staging, `${id}.meta`)).catch(() => undefined), unlink(join(staging, `${id}.webp`)).catch(() => undefined)]);
    throw err;
  }
  return id;
}

export async function assertTemporaryProfileImage(id: string, email: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Profile image upload is invalid or expired.");
  await ensureDirs();
  try {
    const [meta, info] = await Promise.all([
      readFile(join(staging, `${id}.meta`), "utf8").then((value) => JSON.parse(value) as { emailDigest: string; expiresAt: number }),
      stat(join(staging, `${id}.webp`)),
    ]);
    if (meta.expiresAt < Date.now() || meta.emailDigest !== emailDigest(email) || !info.isFile()) throw new Error();
    // A verified request refreshes the reservation window so a concurrent
    // abandoned-upload sweep cannot remove the image during provisioning.
    await writeFile(join(staging, `${id}.meta`), JSON.stringify({ emailDigest: meta.emailDigest, expiresAt: Date.now() + TTL_MS }), { mode: 0o600 });
  } catch { throw new Error("Profile image upload is invalid or expired. Please upload it again."); }
}

export async function finalizeProfileImage(id: string) {
  await ensureDirs();
  try { await rename(join(staging, `${id}.webp`), join(root, `${id}.webp`)); } catch (err) {
    // Idempotent recovery when a previous request finalized the same object.
    try { await stat(join(root, `${id}.webp`)); } catch { throw err; }
  }
  await unlink(join(staging, `${id}.meta`)).catch(() => undefined);
}

export async function readProfileImage(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  await ensureDirs();
  for (const file of [join(root, `${id}.webp`), join(staging, `${id}.webp`)]) {
    try { return await readFile(file); } catch { /* try the other state */ }
  }
  return null;
}

export async function cleanupTemporaryProfileImages(referencedIds: Set<string> = new Set()) {
  await ensureDirs();
  for (const name of await readdir(staging)) {
    if (!name.endsWith(".meta")) continue;
    const id = name.slice(0, -5);
    if (referencedIds.has(id)) continue;
    try {
      const meta = JSON.parse(await readFile(join(staging, name), "utf8")) as { expiresAt: number };
      if (meta.expiresAt <= Date.now()) {
        await Promise.all([unlink(join(staging, `${id}.webp`)).catch(() => undefined), unlink(join(staging, name)).catch(() => undefined)]);
      }
    } catch { await Promise.all([unlink(join(staging, `${id}.webp`)).catch(() => undefined), unlink(join(staging, name)).catch(() => undefined)]); }
  }
}
