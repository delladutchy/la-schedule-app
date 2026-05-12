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
  raw: string;
}

export function classifyGoogleError(error: unknown): GoogleErrorClassification {
  const raw = error instanceof Error ? error.message : String(error);
  const isAuthFailure = /invalid_grant|invalid_client|unauthorized_client/i.test(raw);
  const isRateLimit = /quota exceeded|rateLimitExceeded|userRateLimitExceeded/i.test(raw);
  return { isAuthFailure, isRateLimit, raw };
}

export const CALENDAR_AUTH_FAILED_MESSAGE =
  "Calendar connection needs attention. Please contact Jeff.";

export const CALENDAR_RATE_LIMIT_MESSAGE =
  "Google Calendar is rate-limiting sync right now. Wait about a minute and try again.";
