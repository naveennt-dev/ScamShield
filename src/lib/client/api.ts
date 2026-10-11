"use client";

/** Browser-side API client. Unwraps the { success, data | error } envelope. */

export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isForm = typeof FormData !== "undefined" && init.body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: { ...(isForm || !init.body ? {} : { "Content-Type": "application/json" }), ...init.headers },
    });
  } catch {
    throw new ApiClientError("NETWORK", "Could not reach ScamShield. Check your connection and try again.", 0);
  }
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    // non-JSON (e.g. platform error page)
  }
  const env = payload as { success?: boolean; data?: T; error?: { code: string; message: string; requestId?: string } } | null;
  if (!res.ok || !env?.success) {
    throw new ApiClientError(
      env?.error?.code ?? "HTTP_ERROR",
      env?.error?.message ?? `Request failed (${res.status})`,
      res.status,
      env?.error?.requestId,
    );
  }
  return env.data as T;
}

export function postJson<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, { method: "POST", body: JSON.stringify(body) });
}
