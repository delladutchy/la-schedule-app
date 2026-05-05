/**
 * Service Worker cache helpers.
 *
 * !!! These helpers are mirrored verbatim into public/sw.js. !!!
 * !!! Keep both copies in sync.                              !!!
 *
 * Bucket rules:
 *   - Bucket is derived ONLY from the la_editor_session cookie.
 *   - The raw `?editor=TOKEN` query string is NEVER stored — neither
 *     in cache keys nor in cached responses (callers must skip
 *     `cache.put` when the request URL had `?editor`).
 *   - Unknown / missing cookie collapses to "anon".
 *
 * The cookie's signature is NOT verified here — the SW just reads the
 * editorId field for cache partitioning. The server still authoritatively
 * signs and validates the cookie when it produces the actual response;
 * a tampered cookie can only put a request into the wrong bucket on
 * the user's own device, never read another user's bucket.
 */

const KNOWN_EDITORS = ["jeff", "legacy", "dave", "milos", "mike"] as const;
const SESSION_COOKIE_NAME = "la_editor_session";

export const SHELL_BUCKET_NAMESPACE_EDITOR = "ed";
export const SHELL_BUCKET_ANON = "anon";
export const SHELL_CACHE_NAME = "la-app-shell:v1";

export function parseCookieValue(
  cookieHeader: string | null | undefined,
  cookieName: string,
): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";");
  for (const raw of parts) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith(cookieName + "=")) continue;
    const value = trimmed.slice(cookieName.length + 1).trim();
    return value || null;
  }
  return null;
}

function base64UrlDecode(payloadB64: string): string | null {
  try {
    const normalized = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    if (typeof atob === "function") return atob(normalized);
    if (typeof Buffer !== "undefined") {
      return Buffer.from(normalized, "base64").toString("binary");
    }
    return null;
  } catch {
    return null;
  }
}

export function decodeSessionEditorIdFromCookie(rawCookie: string | null): string | null {
  if (!rawCookie) return null;
  const dotIndex = rawCookie.indexOf(".");
  if (dotIndex <= 0) return null;
  const payloadB64 = rawCookie.slice(0, dotIndex);
  const decoded = base64UrlDecode(payloadB64);
  if (decoded === null) return null;
  let claims: { editorId?: unknown };
  try {
    claims = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (typeof claims.editorId !== "string") return null;
  const normalized = claims.editorId.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function deriveShellBucket(cookieHeader: string | null): string {
  const editorId = decodeSessionEditorIdFromCookie(
    parseCookieValue(cookieHeader, SESSION_COOKIE_NAME),
  );
  if (editorId && (KNOWN_EDITORS as readonly string[]).includes(editorId)) {
    return SHELL_BUCKET_NAMESPACE_EDITOR + ":" + editorId;
  }
  return SHELL_BUCKET_ANON;
}

export function buildShellCacheKey(rawUrl: string, bucket: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "shell:" + bucket + ":invalid";
  }
  // Strip the editor token from the cache key. It is NEVER persisted.
  url.searchParams.delete("editor");
  // Stable ordering so equivalent URLs collapse to one cache slot.
  const entries = Array.from(url.searchParams.entries());
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const search = entries.length === 0
    ? ""
    : "?" + entries.map(([k, v]) => k + "=" + v).join("&");
  return "shell:" + bucket + ":" + url.pathname + search;
}

export interface NavigationRequestSignals {
  /** request.mode — "navigate" only for top-level document loads. */
  mode?: string | null;
  /** request.destination — "document" for top-level loads. */
  destination?: string | null;
  /** Value of the RSC request header (set by Next.js app router on RSC fetches). */
  rscHeader?: string | null;
  /** Value of the Next-Router-Prefetch header (set on RSC prefetches). */
  prefetchHeader?: string | null;
  /** Value of the Accept header — top-level docs always include text/html. */
  acceptHeader?: string | null;
}

/**
 * Decide whether the SW should serve this request from the navigation
 * shell cache. The previous implementation matched purely on pathname,
 * which incorrectly intercepted Next.js RSC/router data fetches and
 * broke client-side navigation in PWA mode. Now requires all of:
 *   - GET method
 *   - request.mode === "navigate" (top-level document load)
 *   - request.destination === "document"
 *   - no RSC header
 *   - no Next-Router-Prefetch header
 *   - no `_rsc` query param
 *   - Accept header includes text/html
 *   - pathname is the home route
 *
 * Each `signals` field is treated as informational: when omitted the
 * check is skipped (so older tests that called the two-argument form
 * keep working). When present, mismatches reject the request.
 */
export function shouldHandleNavigationRequest(
  rawUrl: string,
  method: string,
  signals: NavigationRequestSignals = {},
): boolean {
  if (method !== "GET") return false;

  // Hard exclusions: any RSC/prefetch indicator means it's a router
  // data request, NOT a document navigation.
  if (signals.rscHeader) return false;
  if (signals.prefetchHeader) return false;

  // request.mode and request.destination are the canonical signals.
  if (signals.mode != null && signals.mode !== "navigate") return false;
  if (signals.destination != null && signals.destination !== "document") return false;

  // Document navigations always advertise text/html.
  if (signals.acceptHeader != null && !signals.acceptHeader.includes("text/html")) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  // Defensive guard: some Next.js versions tag RSC fetches with `_rsc`.
  if (url.searchParams.has("_rsc")) return false;

  return url.pathname === "/" || url.pathname === "";
}

/**
 * Decide whether a successful response is allowed to be persisted into
 * the shell cache. Token-bearing requests are NEVER persisted because
 * the server-rendered HTML embeds the editor token in component props.
 */
export function shouldPersistResponseForRequest(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.searchParams.has("editor")) return false;
  return true;
}
