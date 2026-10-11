import { expect, test, type Page } from "@playwright/test";

async function expectNoHorizontalScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, label).toBeLessThanOrEqual(1);
}

test("mobile navigation works and pages fit the viewport (with real content)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  // Create content with long unbroken text so layout overflow bugs would show up.
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("link", { name: "Scan Message", exact: true }).click();
  await page.getByRole("button", { name: "Try: Fake KYC message" }).click();
  await page.getByRole("button", { name: "Check message" }).click();
  await expect(page.getByTestId("risk-level")).toBeVisible({ timeout: 30_000 });
  await expectNoHorizontalScroll(page, "result");

  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("link", { name: "Scan Email", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scan Email" })).toBeVisible();

  for (const path of ["/", "/scan/message", "/scan/url", "/scan/screenshot", "/scan/email", "/history", "/reports", "/settings"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expectNoHorizontalScroll(page, path);
  }
});
