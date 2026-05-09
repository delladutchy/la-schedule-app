/**
 * Classifies errors from googleapis so route handlers can decide whether to
 * surface a "calendar auth needs attention" 503 vs. a generic 502.
 *
 * Raw Google error text (e.g. "invalid_grant") must never reach the client —
 * callers log `raw` server-side and respond with the friendly message.
 */

export interface GoogleErrorClassification {
  isAuthFailure: boolean;
  raw: string;
}

export function classifyGoogleError(error: unknown): GoogleErrorClassification {
  const raw = error instanceof Error ? error.message : String(error);
  const isAuthFailure = /invalid_grant|invalid_client|unauthorized_client/i.test(raw);
  return { isAuthFailure, raw };
}

export const CALENDAR_AUTH_FAILED_MESSAGE =
  "Calendar connection needs attention. Please contact Jeff.";
