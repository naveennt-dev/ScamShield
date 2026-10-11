import { getEnv } from "@/lib/config/env";
import { readJson } from "@/lib/api/body";
import { preflight, withApi } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { CreateReportSchema } from "@/lib/schemas/api";
import { recordEvent } from "@/lib/services/events";
import { createReport, listReports } from "@/lib/services/report-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApi({ route: "v1.reports.list", auth: "required", rateLimit: "read" }, async ({ requestId, startedAt, user }) => {
  return ok({ items: await listReports(user!.id) }, { requestId, startedAt });
});

export const POST = withApi({ route: "v1.reports.create", auth: "required", rateLimit: "report" }, async ({ req, requestId, startedAt, user }) => {
  const input = await readJson(req, CreateReportSchema, getEnv().MAX_BODY_BYTES);
  const report = await createReport(user!.id, input);
  recordEvent({ eventType: "REPORT_CREATED", requestId, userId: user!.id, metadata: { category: input.category, type: input.reportType } });
  return ok(report, { requestId, startedAt }, { status: 201 });
});

export const OPTIONS = preflight;
