import { describe, expect, it } from "vitest";
import { sanitizeSmsBody } from "../sms";

describe("sanitizeSmsBody", () => {
  it("strips HTML before sending SMS bodies", () => {
    expect(sanitizeSmsBody("<b>Hello</b> &amp; <script>alert(1)</script>done")).toBe("Hello & done");
  });

  it("removes links outside the approved SMS/pay-link domains", () => {
    const body = sanitizeSmsBody("Pay at https://evil.example/pay or track https://trip.uber.com/abc");
    expect(body).toContain("[link removed]");
    expect(body).toContain("https://trip.uber.com/abc");
    expect(body).not.toContain("evil.example");
  });
});
