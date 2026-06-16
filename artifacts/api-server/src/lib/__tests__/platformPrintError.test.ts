import { describe, expect, it } from "vitest";
import { extractApiErrorMessage } from "../../../../../artifacts/platform/src/pages/admin/print-error";

describe("Print Management API error messages", () => {
  it("converts HTML/502 responses into a safe short error", () => {
    const html = "<!DOCTYPE html><html><head><title>myorder.fun | 502: Bad gateway</title></head><body>Cloudflare error page</body></html>";

    const message = extractApiErrorMessage(html, 502, "text/html; charset=UTF-8");

    expect(message).toBe(
      "Print API unavailable (HTTP 502). The server returned an HTML error page instead of JSON; check the API container or Cloudflare origin status, then try again.",
    );
    expect(message).not.toContain("<!DOCTYPE html>");
  });

  it("preserves JSON API error messages", () => {
    expect(extractApiErrorMessage({ error: "Printer bridge unavailable" }, 502, "application/json")).toBe(
      "Printer bridge unavailable",
    );
    expect(extractApiErrorMessage({ message: "lp exited with code 1" }, 502, "application/json")).toBe(
      "lp exited with code 1",
    );
  });
});
