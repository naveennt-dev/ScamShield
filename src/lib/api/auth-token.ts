import { timingSafeEqual } from "node:crypto";

/** Constant-time bearer-token check for machine endpoints (cron, metrics). */
export function bearerMatches(req: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
