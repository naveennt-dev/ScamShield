/**
 * Error codes returned to clients. Messages are generic and never include user content,
 * provider responses or stack traces.
 */
export const ERROR_CATALOG = {
  VALIDATION_ERROR: { status: 400, message: "The request is invalid." },
  MALFORMED_JSON: { status: 400, message: "The request body is not valid JSON." },
  UNAUTHORIZED: { status: 401, message: "You need to sign in to do this." },
  FORBIDDEN: { status: 403, message: "You are not allowed to do this." },
  ORIGIN_NOT_ALLOWED: { status: 403, message: "Cross-origin request rejected." },
  NOT_FOUND: { status: 404, message: "Not found." },
  METHOD_NOT_ALLOWED: { status: 405, message: "Method not allowed." },
  CONFLICT: { status: 409, message: "This already exists." },
  PAYLOAD_TOO_LARGE: { status: 413, message: "The request is too large." },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: "Unsupported file or content type." },
  UNPROCESSABLE: { status: 422, message: "The input could not be processed." },
  RATE_LIMITED: { status: 429, message: "Too many requests. Please wait and try again." },
  SERVICE_UNAVAILABLE: { status: 503, message: "A required service is temporarily unavailable." },
  INTERNAL_ERROR: { status: 500, message: "Something went wrong. Please try again." },
} as const;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export interface FieldIssue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: FieldIssue[];
  readonly headers?: Record<string, string>;

  constructor(code: ErrorCode, message?: string, opts: { details?: FieldIssue[]; headers?: Record<string, string> } = {}) {
    super(message ?? ERROR_CATALOG[code].message);
    this.name = "ApiError";
    this.code = code;
    this.status = ERROR_CATALOG[code].status;
    this.details = opts.details;
    this.headers = opts.headers;
  }
}
