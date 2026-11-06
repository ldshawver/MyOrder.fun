import { describe, expect, it } from "vitest";
import { luciferAuthAppearance, luciferAuthContrastCss } from "../luciferAuthAppearance";

describe("Lucifer Cruz Clerk auth appearance", () => {
  it("keeps sign-in and sign-up controls on the existing red/burgundy brand", () => {
    expect(luciferAuthAppearance.variables.colorPrimary).toBe("#8b0000");
    expect(luciferAuthAppearance.variables.colorRing).toBe("#dc143c");
    expect(luciferAuthAppearance.elements.formButtonPrimary.backgroundColor).toBe("#8b0000");
    expect(luciferAuthAppearance.elements.formButtonPrimary.color).toBe("#ffffff");
    expect(JSON.stringify(luciferAuthAppearance)).not.toMatch(/#(?:b89456|c7a664|d5b777|b08439)/i);
    expect(luciferAuthContrastCss).not.toMatch(/#(?:b89456|c7a664|d5b777|b08439)/i);
  });

  it("pairs dark card text with white fields and near-black input text", () => {
    expect(luciferAuthAppearance.variables.colorBackground).toBe("#151010");
    expect(luciferAuthAppearance.variables.colorText).toBe("#ffffff");
    expect(luciferAuthAppearance.variables.colorInputBackground).toBe("#ffffff");
    expect(luciferAuthAppearance.variables.colorInputText).toBe("#111111");
    expect(luciferAuthAppearance.elements.formFieldLabel.color).toBe("#ffffff");
    expect(luciferAuthAppearance.elements.formFieldInput.backgroundColor).toBe("#ffffff");
    expect(luciferAuthAppearance.elements.formFieldInput.color).toBe("#111111");
    expect(luciferAuthContrastCss).toContain(".cl-formFieldInput");
    expect(luciferAuthContrastCss).toContain("background-color: #ffffff");
    expect(luciferAuthContrastCss).toContain("color: #111111");
    expect(luciferAuthContrastCss).toContain(".cl-formFieldLabel");
  });
});
