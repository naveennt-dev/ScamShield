import type { ZodType, ZodTypeDef } from "zod";
import { ApiError, type FieldIssue } from "./errors";

/**
 * Reads a request body with a hard byte limit (Content-Length is checked first, then enforced
 * while streaming, since the header can lie or be absent with chunked encoding).
 */
export async function readBodyBytes(req: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw new ApiError("PAYLOAD_TOO_LARGE");
  if (!req.body) return new Uint8Array();

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ApiError("PAYLOAD_TOO_LARGE");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

export function zodIssues(error: { issues: Array<{ path: (string | number)[]; message: string }> }): FieldIssue[] {
  return error.issues.slice(0, 10).map((i) => ({ path: i.path.join(".") || "(body)", message: i.message }));
}

export async function readJson<T>(req: Request, schema: ZodType<T, ZodTypeDef, unknown>, maxBytes: number): Promise<T> {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes("application/json")) throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
  const bytes = await readBodyBytes(req, maxBytes);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError("MALFORMED_JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError("VALIDATION_ERROR", undefined, { details: zodIssues(parsed.error) });
  return parsed.data;
}
