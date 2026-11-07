import { describe, expect, it } from "vitest";
import {
  isBrightekPos80,
  rerouteBanner,
  shouldRerouteToBrightek,
  sourcePrinterLabel,
  withRerouteBanner,
} from "../printFallback";

describe("Brightek receipt fallback banner", () => {
  it("names the printer the slip was routed to", () => {
    expect(rerouteBanner("MHTP80E")).toBe("******** Rerouted from MHTP80E  ********");
    expect(rerouteBanner("RPP02N")).toBe("******** Rerouted from RPP02N  ********");
  });

  it("puts the note on the first line of a plain receipt", () => {
    expect(withRerouteBanner("ORDER 77", "RPP02N")).toBe(
      "******** Rerouted from RPP02N  ********\nORDER 77",
    );
  });

  it("prints the note after one ESC/POS init so the printer does not clear it", () => {
    const stored = withRerouteBanner("\x1b@BODY", "MHTP80E");
    expect(stored).not.toContain("\x00");
    expect(stored).toContain("\u2400");
    const decoded = stored.replaceAll("\u2400", "\x00");
    const note = "******** Rerouted from MHTP80E  ********";
    expect(decoded.startsWith("\x1b@")).toBe(true);
    expect(decoded.indexOf(note)).toBeGreaterThan(1);
    expect(decoded.indexOf("BODY")).toBeGreaterThan(decoded.indexOf(note));
    expect(decoded.slice(2)).not.toContain("\x1b@");
  });

  it("does not add a second note", () => {
    const once = withRerouteBanner("ORDER", "MPT_II");
    expect(withRerouteBanner(once, "MPT_II")).toBe(once);
  });

  it("uses the bridge queue name and strips control characters", () => {
    expect(sourcePrinterLabel({ bridgePrinterName: "RPP02N", name: "Box 2" })).toBe("RPP02N");
    expect(sourcePrinterLabel({ bridgePrinterName: null, name: "Box 1" })).toBe("Box 1");
    expect(sourcePrinterLabel({ bridgePrinterName: "MHT\x1bP80E", name: "ignored" })).toBe("MHTP80E");
  });

  it("reroutes a thermal slip that was not already aimed at the Brightek", () => {
    const job = { renderFormat: "text", jobType: "customer_receipt", idempotencyKey: "order_receipt:1:77", payloadJson: {} };
    expect(shouldRerouteToBrightek(job, { bridgePrinterName: "RPP02N", name: "Box 2" })).toBe(true);
    expect(shouldRerouteToBrightek(job, { bridgePrinterName: "Brightek_POS80", name: "Brightek POS80" })).toBe(false);
    expect(shouldRerouteToBrightek(job, { bridgePrinterName: null, name: "Brightek POS80" })).toBe(false);
    expect(isBrightekPos80({ bridgePrinterName: "Brightek_POS80", name: "other" })).toBe(true);
    expect(shouldRerouteToBrightek({ ...job, renderFormat: "png" }, { bridgePrinterName: "RPP02N" })).toBe(false);
    expect(shouldRerouteToBrightek({ ...job, jobType: "label" }, { bridgePrinterName: "RPP02N" })).toBe(false);
    expect(shouldRerouteToBrightek({ ...job, jobType: "thank_you_sticker" }, { bridgePrinterName: "RPP02N" })).toBe(false);
    expect(shouldRerouteToBrightek({ ...job, idempotencyKey: "reroute:order_receipt:1:77" }, { bridgePrinterName: "RPP02N" })).toBe(false);
    expect(shouldRerouteToBrightek(
      { ...job, payloadJson: { reroutedFrom: "RPP02N", rerouteOfJobId: 139 } },
      { bridgePrinterName: "Other" },
    )).toBe(false);
  });
});
