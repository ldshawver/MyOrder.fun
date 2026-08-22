import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../../..");
const api = readFileSync(resolve(root, "artifacts/api-server/src/routes/staging-sticker-bridge.ts"), "utf8");
const policy = readFileSync(resolve(root, "artifacts/api-server/src/lib/stagingStickerBridgePolicy.ts"), "utf8");
const bridge = readFileSync(resolve(root, "deploy/print-bridge/staging-pull-bridge.js"), "utf8");
const cupsCore = readFileSync(resolve(root, "deploy/print-bridge/staging-pull-core.js"), "utf8");
const migration = readFileSync(resolve(root, "lib/db/drizzle/0044_staging_sticker_pull_bridge.sql"), "utf8");
const constraintRepair = readFileSync(resolve(root, "lib/db/drizzle/0045_sticker_print_job_constraints.sql"), "utf8");
const app = readFileSync(resolve(root, "artifacts/api-server/src/app.ts"), "utf8");

describe("staging outbound MARKLIFE bridge invariants", () => {
  it("authenticates a staging-only pull bridge without storing or returning plaintext credentials", () => {
    expect(api).toContain('process.env.NODE_ENV !== STAGING');
    expect(api).toContain('X-MyOrder-Environment');
    expect(policy).toContain('timingSafeEqual');
    expect(api).toContain('credentialHash: secretHash(secret)');
    expect(api).not.toContain("credential: secret");
    expect(api).not.toContain("secret }");
  });

  it("atomically claims one approved tenant/location route and prevents duplicate submission", () => {
    expect(api).toContain("FOR UPDATE SKIP LOCKED LIMIT 1");
    expect(api).toContain("j.approval_state='approved'");
    expect(api).toContain("j.submission_attempts=0");
    expect(api).toContain('DUPLICATE_SUBMISSION_PREVENTED');
    expect(migration).toContain('UNIQUE ("tenant_id", "location_id", "job_type")');
  });

  it("allows only the approved queue, one copy, fixed media and exact raster identity", () => {
    for (const expected of ["MARKLIFE_X2", "Custom.1.9375x1.9375in", "203dpi", "copies !== 1", "thank_you_sticker"]) expect(bridge).toContain(expected);
    expect(bridge).toContain('PageSize=${MEDIA}');
    expect(bridge).toContain('ImgMirror=0');
    expect(bridge).toContain('ImgNegative=0');
    expect(bridge).toContain('Darkness=10');
    expect(bridge).not.toMatch(/lp", \[(?!"-d", QUEUE)/);
  });

  it("fails closed without fallback and never retries an ambiguous submission", () => {
    expect(bridge).toContain('submissionAttempted: true');
    expect(bridge).toContain('Local duplicate submission prevented');
    expect(bridge).toContain('submission_unknown');
    expect(bridge).not.toContain('lpr');
    expect(bridge).not.toContain('PRINTER_NAME');
    expect(bridge).not.toContain('DIRECT_PRINTER');
  });

  it("tracks exact CUPS request completion and differentiated terminal states", () => {
    expect(cupsCore).toContain('request id is\\s+(MARKLIFE_X2-(\\d+))');
    expect(bridge).toContain('["-W", "not-completed", "-l", "-o", QUEUE]');
    expect(bridge).toContain('["-W", "completed", "-l", "-o", QUEUE]');
    expect(bridge).toContain("extractCupsJobRecord(activeHistory, requestId)");
    for (const state of ["printer_unavailable", "submission_unknown", "cups_failed", "canceled", "timed_out"]) expect(bridge).toContain(state);
  });

  it("uses discovery-only health checks and does not expose CUPS or accept inbound print requests", () => {
    expect(bridge).toContain('lpstat');
    expect(bridge).not.toContain('createServer');
    expect(bridge).not.toContain('listen(');
    expect(bridge).not.toContain('631');
  });

  it("permits sticker lifecycle states and sanitizes staging 5xx responses", () => {
    expect(constraintRepair).toContain("'thank_you_sticker'");
    for (const state of ["claimed", "submitting", "submitted", "completed", "submission_unknown"]) expect(constraintRepair).toContain(`'${state}'`);
    expect(app).toContain('status >= 500 ? "Internal Server Error" : internalMessage');
    expect(app).toContain('process.env["NODE_ENV"] === "development"');
    expect(app).toContain("requestId: req.id");
  });
});
