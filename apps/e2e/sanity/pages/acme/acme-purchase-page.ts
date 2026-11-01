import { expect, type Page } from "@playwright/test";
import { AcmeBasePage } from "./acme-base-page";

/**
 * Page object for Acme app purchase flow
 */
export class AcmePurchasePage extends AcmeBasePage {
  constructor(page: Page) {
    super(page);
  }

  /**
   * Navigate to the purchase page
   */
  async goto() {
    await super.goto("/purchase");
  }

  /**
   * Complete a purchase
   */
  async completePurchase(amount: number) {
    const products = this.page.locator('[data-testid^="product-"]');
    await expect(products.first()).toBeVisible();
    const prices = await products.locator("p").allTextContents();
    const index = prices.findIndex((text) => {
      const price = text.match(/^\s*\$(\d+(?:\.\d+)?)\s*\/mo\s*$/);
      return price !== null && Number(price[1]) === amount;
    });
    expect(index, `No ACME plan has the requested price ${amount}`).toBeGreaterThanOrEqual(0);
    const product = products.nth(index);
    const name = await product.getByRole("heading", { level: 2 }).innerText();
    const [message] = await Promise.all([
      this.page.waitForEvent("dialog").then(async (dialog) => {
        const message = dialog.message();
        await dialog.accept();
        return message;
      }),
      product.getByRole("button", { name: "Purchase", exact: true }).click(),
    ]);
    expect(message).toBe(`Successfully purchased ${name}!`);
    await expect(this.page).toHaveURL(`${this.baseUrl}/dashboard`);
  }

}
