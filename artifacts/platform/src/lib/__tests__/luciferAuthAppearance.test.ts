import { describe, expect, it } from "vitest";
import { luciferAuthAppearance } from "../luciferAuthAppearance";

describe("Lucifer Cruz Clerk auth appearance", () => {
  it("keeps sign-in and sign-up controls on the existing red/burgundy brand", () => {
    expect(luciferAuthAppearance.variables.colorPrimary).toBe("#8b0000");
    expect(luciferAuthAppearance.variables.colorRing).toBe("#dc143c");
    expect(luciferAuthAppearance.elements.formButtonPrimary.backgroundColor).toBe("#8b0000");
    expect(JSON.stringify(luciferAuthAppearance)).not.toMatch(/#(?:b89456|c7a664|d5b777|b08439)/i);
  });
});
