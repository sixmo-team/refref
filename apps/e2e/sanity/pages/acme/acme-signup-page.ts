import { expect, type Page } from "@playwright/test";
import { AcmeBasePage } from "./acme-base-page";
import { getTestConfig } from "../../../utils/config";

/**
 * Page object for Acme app signup page
 */
export class AcmeSignupPage extends AcmeBasePage {
  constructor(page: Page) {
    super(page);
  }

  /**
   * Navigate to signup page with referral link
   */
  async gotoWithReferralLink(referralUrl: string) {
    await this.page.goto(referralUrl, { waitUntil: "domcontentloaded", timeout: 10000 });
    const signupUrl = new URL("/signup", this.baseUrl);
    await expect(this.page).toHaveURL(
      (url) => url.origin === signupUrl.origin && url.pathname === signupUrl.pathname,
    );
    await expect(this.page.getByTestId("acme-signup-name")).toBeVisible();
  }

  /**
   * Sign up as a referred user
   */
  async signup(name: string, email: string, password = getTestConfig().testUser.password) {
    await this.page.getByTestId("acme-signup-name").fill(name);
    await this.page.getByTestId("acme-signup-email").fill(email);
    await this.page.getByTestId("acme-signup-password").fill(password);
    const [response] = await Promise.all([
      this.page.waitForResponse(
        (response) => response.url() === new URL("/api/signup", this.baseUrl).href &&
          response.request().method() === "POST",
      ),
      this.page.getByTestId("acme-signup-submit").click(),
    ]);
    expect(response.status()).toBe(201);
    await expect(this.page).toHaveURL(`${this.baseUrl}/dashboard`);
    const dashboard = this.page.getByTestId("acme-dashboard-content");
    await expect(dashboard).toContainText(name);
    await expect(dashboard).toContainText(email);
  }
}
