/**
 * Per-worker test environment. Tests must never touch the development database or a real LLM.
 */
try {
  process.loadEnvFile(".env");
} catch {
  // no .env – fine (CI sets variables explicitly)
}

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
else delete process.env.DATABASE_URL;

delete process.env.OPENROUTER_API_KEY;
delete process.env.REDIS_URL; // in-memory rate limiter for tests
delete process.env.CORS_ALLOWED_ORIGINS;
process.env.LOG_LEVEL = "error";
process.env.OCR_PROVIDER = "disabled";
// The LLM layer is off by default (Phase 3 is local-only); its tests opt in explicitly.
process.env.LLM_ENABLED = "true";
process.env.ML_BACKEND = "embedded"; // unit tests never depend on the Python service
process.env.URL_FETCH_ENABLED = "false";
process.env.BETTER_AUTH_SECRET ??= "test-secret-test-secret-test-secret-1234";
