/**
 * Classifies errors from googleapis so route handlers can decide whether to
 * surface a "calendar auth needs attention" 503, a rate-limit message, or a
 * generic 502.
 *
 * Raw Google error text (e.g. "invalid_grant", quota details) must never
 * reach the client — callers log `raw` server-side and respond with the
 * appropriate friendly message constant below.
 */

export interface GoogleErrorClassification {
  isAuthFailure: boolean;
  isRateLimit: boolean;
  /** True when the error is likely transient and a single retry may succeed. */
  isTransient: boolean;
  raw: string;
}

function extractHttpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const e = error as Record<string, unknown>;
  // GaxiosError exposes .status; some googleapis wrappers use .code
  if (typeof e.status === "number") return e.status;
  if (typeof e.code === "number") return e.code;
  return undefined;
}

export function classifyGoogleError(error: unknown): GoogleErrorClassification {
  const raw = error instanceof Error ? error.message : String(error);
  const httpStatus = extractHttpStatus(error);

  // Auth failures: OAuth2 token errors in the message, or HTTP 401 from the
  // Calendar API (e.g. access token used after the refresh_token was revoked).
  const isAuthFailure =
    /invalid_grant|invalid_client|unauthorized_client/i.test(raw) ||
    httpStatus === 401;

  const isRateLimit = /quota exceeded|rateLimitExceeded|userRateLimitExceeded/i.test(raw);

  // Transient errors are worth one retry: server-side faults and network blips.
  // Auth failures and rate limits are never transient.
  const isTransient =
    !isAuthFailure &&
    !isRateLimit &&
    (httpStatus == null ||
      httpStatus >= 500 ||
      /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|network error/i.test(raw));

  return { isAuthFailure, isRateLimit, isTransient, raw };
}

export const CALENDAR_AUTH_FAILED_MESSAGE =
  "Calendar connection needs attention. Please contact Jeff.";

export const CALENDAR_RATE_LIMIT_MESSAGE =
  "Google Calendar is rate-limiting sync right now. Wait about a minute and try again.";
