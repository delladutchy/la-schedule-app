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

export function shouldHandleNavigationRequest(rawUrl: string, method: string): boolean {
  if (method !== "GET") return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
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
