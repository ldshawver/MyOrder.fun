import { describe, expect, it } from "vitest";
import { customerVisibleNote, orderStageView } from "../orderStage";

describe("customer order stage notes", () => {
  it("hides General Queue lines and keeps the rest of a customer note", () => {
    expect(customerVisibleNote("General Queue")).toBeNull();
    expect(customerVisibleNote("General Que is handling cash.")).toBeNull();
    expect(customerVisibleNote("Pull around to the side door.\nGeneral Queue")).toBe("Pull around to the side door.");
    const stage = orderStageView({
      pickupNote: "General Queue\nCall when you arrive.",
      notes: "General Que",
    });
    expect(stage.pickupInstructions).toBe("Call when you arrive.");
    expect(stage.specialNotes).toBeNull();
  });
});
