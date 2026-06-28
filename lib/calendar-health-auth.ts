import {
  authorizeEditorRequest,
  resolveEditorTokenMap,
  resolveEditorIdFromAuthorizationHeader,
} from "./editor-auth";
import type { EnvConfig } from "./config";

/**
 * Resolves the editor ID from a calendar-health request.
 *
 * Accepts (in priority order):
 *   1. Bearer token in the Authorization header
 *   2. Signed session cookie (la_editor_session)
 *   3. ?token= query parameter (emergency browser fallback)
 *
 * Returns the editorId string on success, or null if no valid credential.
 * Never exposes token values.
 */
export function resolveCalendarHealthAuth(
  headers: { get(name: string): string | null },
  queryToken: string | null,
  env: Pick<EnvConfig, "EDITOR_TOKEN" | "EDITOR_TOKENS_JSON">,
): string | null {
  // Paths 1 + 2: Bearer header and signed session cookie via standard helper.
  // Wrapped in try/catch because authorizeEditorRequest calls resolveEditorTokenMap
  // which throws if EDITOR_TOKENS_JSON is empty/missing (startup misconfiguration).
  try {
    const fakeReq = { headers: { get: (n: string) => headers.get(n) } } as Request;
    const auth = authorizeEditorRequest(fakeReq, env);
    if (auth.ok) return auth.editorId;
  } catch {
    // No tokens configured — fall through to return null below.
    return null;
  }

  // Path 3: ?token= query param — browser-friendly emergency fallback.
  const presented = queryToken?.trim() ?? "";
  if (!presented) return null;

  try {
    const tokenMap = resolveEditorTokenMap(env);
    // Reuse the constant-time comparison already in editor-auth.
    return resolveEditorIdFromAuthorizationHeader(`Bearer ${presented}`, tokenMap);
  } catch {
    return null;
  }
}
