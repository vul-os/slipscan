/**
 * Error envelope — matches Go internal/httpx/json.go ErrorBody:
 *   { "error": string, "code"?: string, "details"?: unknown }
 * so the frontend's existing error handling is unchanged.
 */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export interface ErrorBody {
  error: string;
  code?: string;
  details?: unknown;
}

/** Build the error body (Go: httpx.ErrorBody). */
export function errorBody(code: string, message: string, details?: unknown): ErrorBody {
  const b: ErrorBody = { error: message };
  if (code) b.code = code;
  if (details !== undefined) b.details = details;
  return b;
}

/** Write a JSON error response (Go: httpx.WriteError). */
export function writeError(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  details?: unknown,
): Response {
  return c.json(errorBody(code, message, details), status);
}

/** Thrown by handlers/middleware; caught by the app's onError to emit the envelope. */
export class ApiError extends Error {
  status: ContentfulStatusCode;
  code: string;
  details?: unknown;
  constructor(status: ContentfulStatusCode, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
