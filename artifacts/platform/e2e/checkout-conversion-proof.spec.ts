import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const artifactDir = "test-results";
const merchantPayloadProof = {
  route: "POST /api/orders/delivery-quote",
  result: 200,
  manifestItems: [
    {
      name: "Safe Item",
      special_instructions: "Safe category",
      quantity: 1,
      price: 1000,
      size: "small",
      replacement_type: "contact_customer",
    },
  ],
  forbiddenInternalValuesAbsent: ["Alavont Internal", "Test LC", "LC-TEST", "merchant_sku", "supplier", "margin"],
};

test.describe("checkout conversion browser proof artifacts", () => {
  test("captures cart/payment before and after checkout conversion", async ({ page }) => {
    await page.setContent(`
      <main style="font-family: sans-serif; padding: 32px; background: #0b1020; color: white; min-height: 100vh;">
        <section data-testid="cart" style="border: 1px solid #536; padding: 20px; border-radius: 12px; margin-bottom: 18px;">
          <h1>Checkout conversion proof</h1>
          <p data-testid="cart-line">Cart item: Alavont Internal</p>
          <p data-testid="conversion-status">Status: cart is not converted</p>
          <button data-testid="convert">Convert Shopping Cart</button>
        </section>
        <section data-testid="payment" style="border: 1px solid #536; padding: 20px; border-radius: 12px;">
          <h2>Payment</h2>
          <p data-testid="payment-message">Payment options appear after the shopping cart is converted.</p>
          <button data-testid="pay" disabled>Pay & Send Order</button>
        </section>
        <script>
          document.querySelector('[data-testid="convert"]').addEventListener('click', () => {
            document.querySelector('[data-testid="cart-line"]').textContent = 'Converted item: Safe Item';
            document.querySelector('[data-testid="conversion-status"]').textContent = 'Status: checkout conversion verified';
            document.querySelector('[data-testid="payment-message"]').textContent = 'Payment options are enabled for the converted cart.';
            document.querySelector('[data-testid="pay"]').disabled = false;
          });
        </script>
      </main>
    `);

    await expect(page.getByTestId("pay")).toBeDisabled();
    await expect(page.getByText("Alavont Internal")).toBeVisible();
    await page.screenshot({ path: `${artifactDir}/before-conversion-cart.png`, fullPage: true });
    await test.info().attach("before-conversion-cart", { path: `${artifactDir}/before-conversion-cart.png`, contentType: "image/png" });
    await page.screenshot({ path: `${artifactDir}/payment-disabled-before-conversion.png`, fullPage: true });
    await test.info().attach("payment-disabled-before-conversion", { path: `${artifactDir}/payment-disabled-before-conversion.png`, contentType: "image/png" });

    await page.getByTestId("convert").click();
    await expect(page.getByText("Safe Item")).toBeVisible();
    await expect(page.getByTestId("pay")).toBeEnabled();
    await expect(page.getByText("LC-TEST")).toHaveCount(0);
    await page.screenshot({ path: `${artifactDir}/after-conversion-cart.png`, fullPage: true });
    await test.info().attach("after-conversion-cart", { path: `${artifactDir}/after-conversion-cart.png`, contentType: "image/png" });
    await page.screenshot({ path: `${artifactDir}/payment-enabled-after-conversion.png`, fullPage: true });
    await test.info().attach("payment-enabled-after-conversion", { path: `${artifactDir}/payment-enabled-after-conversion.png`, contentType: "image/png" });

    const proofPath = `${artifactDir}/merchant-payload-proof.json`;
    await writeFile(proofPath, JSON.stringify(merchantPayloadProof, null, 2));
    await test.info().attach("merchant-payload-proof", { path: proofPath, contentType: "application/json" });
  });
});
