import { expect, test as setup } from "@playwright/test";

/** Creates one fresh account per device profile via the real sign-up UI and stores the session. */
for (const profile of ["desktop", "mobile"] as const) {
  setup(`sign up (${profile})`, async ({ page }) => {
    const email = `e2e-${profile}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
    await page.goto("/auth");
    await page.getByRole("button", { name: "No account? Create one" }).click();
    await page.getByPlaceholder("Name").fill(`E2E ${profile}`);
    await page.getByPlaceholder("Email").fill(email);
    await page.getByPlaceholder(/Password/).fill("correct-horse-battery-9");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await page.context().storageState({ path: `tests/e2e/.auth/${profile}.json` });
  });
}
