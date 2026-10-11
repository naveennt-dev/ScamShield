import { redactForLog } from "./redact";

/**
 * Minimal structured JSON logger.
 *
 * - One JSON object per line (works with Vercel, Docker, Loki, Datadog …).
 * - All fields pass through `redactForLog`: keys that look like secrets/OTPs/tokens are removed.
 * - Callers must never pass raw user message content; pass lengths/fingerprints instead.
 */

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const lvl = (process.env.LOG_LEVEL as Level) || (process.env.NODE_ENV === "test" ? "error" : "info");
  return ORDER[lvl] ?? ORDER.info;
}

function emit(level: Level, event: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < threshold()) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...(fields ? (redactForLog(fields) as Record<string, unknown>) : {}),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function make(bindings: Record<string, unknown>): Logger {
  return {
    debug: (e, f) => emit("debug", e, { ...bindings, ...f }),
    info: (e, f) => emit("info", e, { ...bindings, ...f }),
    warn: (e, f) => emit("warn", e, { ...bindings, ...f }),
    error: (e, f) => emit("error", e, { ...bindings, ...f }),
    child: (b) => make({ ...bindings, ...b }),
  };
}

export const logger: Logger = make({ service: "scamshield" });
