import { describe, expect, it } from "vitest";
import { isShiftOrderRoutable } from "./orderRouting";

describe("CSR order routing readiness", () => {
  it("blocks an active CSR shift until box, inventory, par, and printer are confirmed", () => {
    expect(isShiftOrderRoutable({ boxAssignmentId: "sales-box-1", setupJson: {} })).toBe(false);
    expect(isShiftOrderRoutable({
      boxAssignmentId: "sales-box-1",
      setupJson: { inventoryConfirmed: true, parLevelsConfirmed: true },
    })).toBe(false);
  });

  it("allows routing only when shift startup prerequisites are complete", () => {
    expect(isShiftOrderRoutable({
      boxAssignmentId: "sales-box-1",
      setupJson: {
        inventoryConfirmed: true,
        parLevelsConfirmed: true,
        printerAssigned: true,
      },
    })).toBe(true);
  });

  it("accepts legacy startup flags written by the clock-in endpoint", () => {
    expect(isShiftOrderRoutable({
      setupJson: {
        boxAssignmentId: "sales-box-2",
        startingInventoryConfirmed: true,
        parLevelsConfirmed: true,
        printerReady: true,
      },
    })).toBe(true);
  });
});
