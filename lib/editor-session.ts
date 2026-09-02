export const EDITOR_TOKEN_SESSION_KEY = "la-schedule-editor-token";

export function sanitizeEditorToken(raw: string | null | undefined): string | null {
  const token = raw?.trim() ?? "";
  return token.length > 0 ? token : null;
}

let sessionEstablished = false;
let sessionInFlight: Promise<boolean> | null = null;

/**
 * Refresh the httpOnly editor session cookie from the token this device
 * already stored, without any user-facing sign-in.
 *
 * The app has exactly one editor identity and no login screen: a one-time
 * `?editor=` link stores the token locally, and `/api/editor/session` exchanges
 * it for the httpOnly `la_editor_session` cookie that every API route reads.
 * EditorTokenBridge only ran that exchange on the main schedule page, so opening
 * an /admin page directly could race or miss it entirely and every request came
 * back 401. Admin pages call this first so the existing session is present
 * before they fetch. Deduped per page load; never exposes the token to markup.
 */
export async function ensureEditorSession(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (sessionEstablished) return true;
  if (sessionInFlight) return sessionInFlight;

  let token: string | null = null;
  try {
    token = sanitizeEditorToken(window.localStorage.getItem(EDITOR_TOKEN_SESSION_KEY));
  } catch {
    return false; // private mode / storage disabled — the cookie may still be valid
  }
  if (!token) return false;

  sessionInFlight = (async () => {
    try {
      const response = await fetch("/api/editor/session", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        credentials: "same-origin",
      });
      sessionEstablished = response.ok;
      return response.ok;
    } catch {
      return false;
    } finally {
      sessionInFlight = null;
    }
  })();
  return sessionInFlight;
}
