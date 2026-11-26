import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const css = readFileSync(new URL("../src/components/holiday-decorations.css", import.meta.url), "utf8");

for (const width of [375, 1440]) {
  test(`holiday decorations preserve shopping interactions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 });
    await page.setContent(`<div class="holiday-storefront">
      <article><div class="holiday-product-image" style="width: 160px; height: 160px"></div>
      <p>Product · $15.00</p><button>Checkout</button></article>
      <div aria-hidden="true" class="holiday-layer" data-theme="christmas" hidden>
        <span class="holiday-corner holiday-corner-left">❄</span>
        <span class="holiday-corner holiday-corner-right">🌿</span>
        <span class="holiday-particle">❄</span>
      </div>
    </div>`);
    await page.addStyleTag({ content: css });
    const card = page.locator("article");
    const before = await card.boundingBox();
    await page.locator(".holiday-storefront").evaluate(element => element.setAttribute("data-holiday", "christmas"));
    await page.locator(".holiday-layer").evaluate(element => element.removeAttribute("hidden"));
    expect(await card.boundingBox()).toEqual(before);
    await expect(page.getByText("Product · $15.00")).toBeVisible();
    await page.getByRole("button", { name: "Checkout" }).click();
    await expect(page.getByRole("button", { name: "Checkout" })).toBeFocused();
    await expect(page.locator(".holiday-layer")).toHaveCSS("pointer-events", "none");
    await expect(page.locator(".holiday-particle")).toHaveCSS("animation-name", "holiday-fall");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.locator(".holiday-particle")).toBeHidden();
  });
}
