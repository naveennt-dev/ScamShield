import { NextResponse } from "next/server";
import { ERROR_CATALOG, type ErrorCode, type FieldIssue } from "./errors";

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  meta: { requestId: string; processingTimeMs: number; version: string };
}

export interface ErrorEnvelope {
  success: false;
  error: { code: ErrorCode; message: string; requestId: string; details?: FieldIssue[] };
}

export const API_VERSION = "v1";

const BASE_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export function ok<T>(
  data: T,
  ctx: { requestId: string; startedAt: number },
  init: { status?: number; headers?: Record<string, string> } = {},
): NextResponse<SuccessEnvelope<T>> {
  return NextResponse.json(
    {
      success: true,
      data,
      meta: { requestId: ctx.requestId, processingTimeMs: Date.now() - ctx.startedAt, version: API_VERSION },
    },
    { status: init.status ?? 200, headers: { ...BASE_HEADERS, "X-Request-Id": ctx.requestId, ...init.headers } },
  );
}

export function fail(
  code: ErrorCode,
  requestId: string,
  opts: { message?: string; details?: FieldIssue[]; headers?: Record<string, string> } = {},
): NextResponse<ErrorEnvelope> {
  return NextResponse.json(
    {
      success: false,
      error: {
        code,
        message: opts.message ?? ERROR_CATALOG[code].message,
        requestId,
        ...(opts.details?.length ? { details: opts.details } : {}),
      },
    },
    { status: ERROR_CATALOG[code].status, headers: { ...BASE_HEADERS, "X-Request-Id": requestId, ...opts.headers } },
  );
}
