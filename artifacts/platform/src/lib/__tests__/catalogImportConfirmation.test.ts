import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "src/pages/admin/import.tsx"), "utf8");

describe("catalogue import confirmation integrity", () => {
  it("sends the server-issued opaque token only from the explicit confirmation flow", () => {
    expect(source).toContain('formData.append("previewConfirmationToken", previewConfirmationToken)');
    expect(source).toContain("const previewConfirmationToken = confirmImport ? confirmationTokenRef.current : null");
    expect(source).toContain("onClick={() => void handleConfirmImport()}");
    expect(source).toContain('type="button"');
  });

  it("invalidates confirmation state for file, preview, actor, expiry, cancel, and attempted consumption", () => {
    expect(source.match(/confirmationTokenRef\.current = null/g)?.length).toBeGreaterThanOrEqual(6);
    expect(source).toContain("previewTokenExpiresAt");
    expect(source).toContain("Import preview expired. Run Import again before confirming.");
    expect(source).toContain("[currentUser?.id]");
  });
});
