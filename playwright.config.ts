import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests run against a production build (`npm run build` first) using email/password auth,
 * which is enabled only for this test server via AUTH_ENABLE_EMAIL_PASSWORD.
 * Requires TEST_DATABASE_URL (or DATABASE_URL) pointing at a migrated, disposable database.
 */
try {
  process.loadEnvFile(".env");
} catch {
  // CI provides env explicitly
}

const PORT = Number(process.env.E2E_PORT ?? 3124);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  // One worker: tests share accounts created once in auth.setup.ts (better-auth rate-limits sign-ups).
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: { baseURL: BASE_URL, trace: "retain-on-failure" },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: "tests/e2e/.auth/desktop.json" },
      testMatch: /app\.spec\.ts/,
      dependencies: ["setup"],
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], storageState: "tests/e2e/.auth/mobile.json" },
      testMatch: /mobile\.spec\.ts/,
      dependencies: ["setup"],
    },
  ],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `${BASE_URL}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
      BETTER_AUTH_URL: BASE_URL,
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "e2e-secret-e2e-secret-e2e-secret-123456",
      AUTH_ENABLE_EMAIL_PASSWORD: "true",
      OPENROUTER_API_KEY: "",
      REDIS_URL: "",
      OCR_PROVIDER: "tesseract",
      LOG_LEVEL: "warn",
    },
  },
});
