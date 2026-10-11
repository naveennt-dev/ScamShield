import { NextResponse } from "next/server";
import { getEnv } from "@/lib/config/env";
import { bearerMatches } from "@/lib/api/auth-token";
import { requestIdFrom } from "@/lib/api/request-context";
import { prisma } from "@/lib/db/prisma";
import { logger } from "@/lib/observability/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Retention job (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`).
 * - Deletes analyses past their expiresAt (indicators/URL analyses cascade).
 * - Deletes analysis events older than EVENT_RETENTION_DAYS.
 * - Deletes unverified intel patterns not seen for a year.
 */
export async function GET(req: Request) {
  const requestId = requestIdFrom(req);
  const env = getEnv();
  if (!env.CRON_SECRET) return new NextResponse("Not found", { status: 404 });
  if (!bearerMatches(req, env.CRON_SECRET)) return new NextResponse("Unauthorized", { status: 401 });

  const now = new Date();
  const eventCutoff = new Date(now.getTime() - env.EVENT_RETENTION_DAYS * 86_400_000);
  const patternCutoff = new Date(now.getTime() - 365 * 86_400_000);
  const [analyses, events, patterns] = await Promise.all([
    prisma.scamAnalysis.deleteMany({ where: { expiresAt: { lte: now } } }),
    prisma.analysisEvent.deleteMany({ where: { createdAt: { lt: eventCutoff } } }),
    prisma.scamPattern.deleteMany({ where: { status: "UNVERIFIED", lastSeen: { lt: patternCutoff } } }),
  ]);
  const summary = { analyses: analyses.count, events: events.count, patterns: patterns.count };
  logger.info("retention_run", { requestId, ...summary });
  return NextResponse.json({ success: true, data: summary, meta: { requestId } }, { headers: { "Cache-Control": "no-store" } });
}
