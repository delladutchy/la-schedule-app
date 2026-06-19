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

/**
 * Pulls the OAuth2 error code and description out of a GaxiosError response
 * body.  When Google rejects a token exchange the HTTP response body is:
 *   { error: "invalid_grant", error_description: "Token has been expired or revoked." }
 * GaxiosError exposes this as `.response.data`.  The top-level `.message` may
 * only repeat the error code (or be a generic fetch error), so callers should
 * log BOTH raw and this for a complete picture.
 */
export function extractOAuthDetail(error: unknown): { code: string | undefined; description: string | undefined } {
  try {
    const e = error as Record<string, unknown>;
    const data = ((e.response as Record<string, unknown> | undefined)?.data) as Record<string, unknown> | undefined;
    const code = typeof data?.error === "string" ? data.error : undefined;
    const description = typeof data?.error_description === "string"
      ? data.error_description.slice(0, 200)
      : undefined;
    return { code, description };
  } catch {
    return { code: undefined, description: undefined };
  }
}

export const CALENDAR_AUTH_FAILED_MESSAGE =
  "Calendar connection needs attention. Please contact Jeff.";

export const CALENDAR_RATE_LIMIT_MESSAGE =
  "Google Calendar is rate-limiting sync right now. Wait about a minute and try again.";

// ---------------------------------------------------------------------------
// Sheets error classification
// ---------------------------------------------------------------------------

/**
 * Converts a raw googleapis/lib error from a Sheets API call into a short,
 * user-visible message. Never exposes raw auth credentials or stack traces.
 *
 * @param error  — the caught error value
 * @param sheetId — GOOGLE_SHEET_ID in use (for context in the message)
 * @param sheetName — GOOGLE_SHEET_NAME in use
 */
export function classifySheetsError(
  error: unknown,
  sheetId?: string,
  sheetName?: string,
): string {
  const raw = error instanceof Error ? error.message : String(error);
  const httpStatus = (() => {
    if (typeof error !== "object" || error === null) return undefined;
    const e = error as Record<string, unknown>;
    if (typeof e.status === "number") return e.status;
    if (typeof e.code === "number") return e.code;
    return undefined;
  })();

  // Config errors (our own messages from lib/google-sheets.ts)
  if (/GOOGLE_SHEET_ID must be set/i.test(raw)) {
    return "GOOGLE_SHEET_ID env var not configured";
  }
  if (/GOOGLE_SERVICE_ACCOUNT_EMAIL must be set/i.test(raw)) {
    return "GOOGLE_SERVICE_ACCOUNT_EMAIL env var not configured";
  }
  if (/GOOGLE_PRIVATE_KEY not found/i.test(raw)) {
    return "GOOGLE_PRIVATE_KEY not configured — set env var or upload via /api/admin/migrate-sheets-key";
  }

  // Auth failures
  if (httpStatus === 401 || /invalid_grant|invalid_client|unauthorized_client/i.test(raw)) {
    return "Sheets auth failed — check GOOGLE_PRIVATE_KEY and service account email";
  }

  // Permission errors
  if (httpStatus === 403 || /caller does not have permission|forbidden/i.test(raw)) {
    const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    return email
      ? `No write access — share the spreadsheet with Editor access to ${email}`
      : "No write access — share the spreadsheet with Editor access to the service account";
  }

  // Spreadsheet not found
  if (httpStatus === 404 || /not found|Requested entity was not found/i.test(raw)) {
    return sheetId
      ? `Spreadsheet not found — verify GOOGLE_SHEET_ID (${sheetId.slice(0, 12)}…)`
      : "Spreadsheet not found — verify GOOGLE_SHEET_ID env var";
  }

  // Tab/range errors
  if (/Unable to parse range|Invalid range|No grid with id/i.test(raw)) {
    return sheetName
      ? `Sheet tab not found — verify GOOGLE_SHEET_NAME is exactly "${sheetName}"`
      : "Sheet tab not found — verify GOOGLE_SHEET_NAME env var";
  }

  // Rate limit
  if (/quota exceeded|rateLimitExceeded/i.test(raw)) {
    return "Sheets rate limit hit — wait a minute and retry";
  }

  // Generic
  return "Sheet sync failed — check server logs for details";
}
