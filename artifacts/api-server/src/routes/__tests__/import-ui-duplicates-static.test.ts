import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(resolve(process.cwd(), "../platform/src/pages/admin/import.tsx"), "utf8");

describe("import UI duplicate diagnostics", () => {
  it("renders structured duplicate warnings in the import error panel", () => {
    expect(src).toContain("type ImportDuplicateWarning");
    expect(src).toContain("function DuplicateWarningsList");
    expect(src).toContain("Duplicate warnings");
    expect(src).toContain("Rows: {warning.rows.join");
    expect(src).toContain("<DuplicateWarningsList warnings={result?.duplicateWarnings} />");
  });
});
