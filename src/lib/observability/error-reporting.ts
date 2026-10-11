import { logger } from "./logger";

/**
 * Error-reporting integration point (Sentry or equivalent).
 *
 * Status: integration point only. No Sentry SDK is bundled. To enable Sentry:
 *   1. `npm install @sentry/nextjs` and run its wizard,
 *   2. call `registerErrorReporter((err, ctx) => Sentry.captureException(err, { extra: ctx }))`
 *      from `instrumentation.ts`.
 * Until a reporter is registered, errors are written to the structured log only.
 */

type Reporter = (error: unknown, context: Record<string, unknown>) => void;

let reporter: Reporter | null = null;

export function registerErrorReporter(r: Reporter): void {
  reporter = r;
}

export function reportError(error: unknown, context: Record<string, unknown> = {}): void {
  logger.error("unhandled_error", { ...context, error });
  try {
    reporter?.(error, context);
  } catch {
    // never let the reporter break the request
  }
}
