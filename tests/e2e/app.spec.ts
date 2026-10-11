import { expect, test, type Page } from "@playwright/test";

function trackCspViolations(page: Page) {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
  return violations;
}

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("unauthenticated users are redirected to sign-in", async ({ page }) => {
    await page.goto("/history");
    await expect(page).toHaveURL(/\/auth\?next=%2Fhistory/);
    await expect(page.getByRole("button", { name: /Sign in with email/ })).toBeVisible();
  });
});

test("scan message → view result → report → history → dashboard", async ({ page }) => {
  const csp = trackCspViolations(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  const before = Number(await page.getByTestId("stat-total-scans").innerText());

  await page.getByRole("link", { name: "Scan Message", exact: true }).click();
  await page.getByRole("button", { name: "Try: Fake KYC message" }).click();
  await page.getByRole("button", { name: "Check message" }).click();
  const result = page.getByTestId("analysis-result");
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("risk-level")).toHaveText(/HIGH RISK|CRITICAL/);
  await expect(result.getByText("Why this was detected")).toBeVisible();
  await expect(result.getByText("Do not click the link.")).toBeVisible();
  await expect(result.getByText("sbi-kyc-update.xyz").first()).toBeVisible();
  // Suspicious links are rendered as text, never as clickable anchors.
  await expect(result.locator('a[href*="sbi-kyc-update"]')).toHaveCount(0);

  await result.getByRole("button", { name: "Report scam" }).click();
  await result.getByRole("button", { name: "Submit report" }).click();
  await expect(page.getByText(/your report was recorded|people have now reported/)).toBeVisible();

  await page.getByRole("link", { name: "History", exact: true }).click();
  const item = page.getByRole("link", { name: /Dear SBI customer/ }).first();
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.getByTestId("risk-level")).toHaveText(/HIGH RISK|CRITICAL/);
  await expect(page.getByText("Back to history")).toBeVisible();

  await page.getByRole("link", { name: "Scam Reports", exact: true }).click();
  await expect(page.getByText(/Dear SBI customer/).first()).toBeVisible();

  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.getByTestId("stat-total-scans")).toHaveText(String(before + 1));
  expect(csp).toEqual([]);
});

test("a legitimate bank OTP message is shown as safe", async ({ page }) => {
  await page.goto("/scan/message");
  await page.getByRole("button", { name: "Try: Normal bank OTP" }).click();
  await page.getByRole("button", { name: "Check message" }).click();
  await expect(page.getByTestId("risk-level")).toHaveText("SAFE", { timeout: 30_000 });
});

test("URL scan flags an internal address", async ({ page }) => {
  await page.goto("/scan/url");
  await page.getByLabel("Link to check").fill("http://169.254.169.254/latest/meta-data/");
  await page.getByRole("button", { name: "Check link" }).click();
  await expect(page.getByText(/private\/internal network address/).first()).toBeVisible({ timeout: 30_000 });
});

test("screenshot scan reads text with OCR and analyses it", async ({ page }) => {
  await page.goto("/scan/screenshot");
  await page.locator('input[type="file"]').setInputFiles("tests/fixtures/scam.png");
  await page.getByRole("button", { name: "Analyse screenshot" }).click();
  await expect(page.getByTestId("risk-level")).toHaveText(/HIGH RISK|CRITICAL/, { timeout: 60_000 });
  await page.getByText("Text we read from the image").click();
  await expect(page.getByText(/KYC has expired/)).toBeVisible();
});

test("email scan warns about dangerous attachments", async ({ page }) => {
  await page.goto("/scan/email");
  await page.getByLabel("From (as shown in your inbox)").fill('"SBI Bank" <sbi.alerts@gmail.com>');
  await page.getByLabel("Subject").fill("Your account is blocked");
  await page.getByLabel("Email body").fill("Your KYC is pending. Open the attached form today or your account will be suspended.");
  await page.getByPlaceholder("e.g. invoice.pdf.exe").fill("KYC_form.pdf.exe");
  await page.getByRole("button", { name: "Add" }).click();
  await page.getByRole("button", { name: "Check email" }).click();
  await expect(page.getByText("Risky attachments — do not open:")).toBeVisible({ timeout: 30_000 });
});

// Runs last in this file: it invalidates the shared desktop session.
test("sign out returns to the sign-in page", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/auth/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/auth/);
});
