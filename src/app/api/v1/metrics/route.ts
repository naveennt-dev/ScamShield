import { NextResponse } from "next/server";
import { getEnv } from "@/lib/config/env";
import { bearerMatches } from "@/lib/api/auth-token";
import { renderPrometheus } from "@/lib/observability/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Prometheus scrape endpoint. Disabled (404) unless METRICS_TOKEN is set; requires Bearer token. */
export async function GET(req: Request) {
  const token = getEnv().METRICS_TOKEN;
  if (!token) return new NextResponse("Not found", { status: 404 });
  if (!bearerMatches(req, token)) return new NextResponse("Unauthorized", { status: 401 });
  return new NextResponse(renderPrometheus(), {
    headers: { "Content-Type": "text/plain; version=0.0.4", "Cache-Control": "no-store" },
  });
}
