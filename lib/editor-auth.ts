import type { EnvConfig } from "./config";

const EDITOR_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;

export type EditorAuthResult =
  | { ok: true; editorId: string }
  | { ok: false };

export type EditorRole = "full" | "limited";

export function resolveEditorRole(editorId: string): EditorRole {
  return editorId === "milos" ? "limited" : "full";
}

export function canEditorModifyEventOwner(
  editorId: string,
  ownerEditor: string | undefined,
): boolean {
  if (resolveEditorRole(editorId) === "full") return true;
  return !!ownerEditor && ownerEditor === editorId;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function parseNamedEditorTokens(raw: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("EDITOR_TOKENS_JSON must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("EDITOR_TOKENS_JSON must be a JSON object.");
  }

  const entries = Object.entries(parsed);
  if (entries.length === 0) {
    throw new Error("EDITOR_TOKENS_JSON must include at least one editor token.");
  }

  const tokenMap: Record<string, string> = {};
  for (const [rawEditorId, rawToken] of entries) {
    const editorId = rawEditorId.trim().toLowerCase();
    if (!EDITOR_ID_PATTERN.test(editorId)) {
      throw new Error(
        `EDITOR_TOKENS_JSON has invalid editor id "${rawEditorId}". Use lowercase letters, numbers, "_" or "-".`,
      );
    }
    if (typeof rawToken !== "string") {
      throw new Error(`EDITOR_TOKENS_JSON token for "${editorId}" must be a string.`);
    }
    const token = rawToken.trim();
    if (token.length < 16) {
      throw new Error(`EDITOR_TOKENS_JSON token for "${editorId}" must be at least 16 characters.`);
    }
    tokenMap[editorId] = token;
  }

  return tokenMap;
}

export function resolveEditorTokenMap(
  env: Pick<EnvConfig, "EDITOR_TOKEN" | "EDITOR_TOKENS_JSON">,
): Record<string, string> {
  const tokenMap: Record<string, string> = {};

  if (env.EDITOR_TOKENS_JSON?.trim()) {
    const named = parseNamedEditorTokens(env.EDITOR_TOKENS_JSON.trim());
    Object.assign(tokenMap, named);
  }

  const legacyToken = env.EDITOR_TOKEN?.trim();
  if (legacyToken && !tokenMap.legacy) {
    tokenMap.legacy = legacyToken;
  }

  if (Object.keys(tokenMap).length === 0) {
    throw new Error("No editor tokens configured.");
  }

  return tokenMap;
}

export function resolveEditorIdFromAuthorizationHeader(
  authorizationHeader: string | null,
  tokenMap: Record<string, string>,
): string | null {
  const header = authorizationHeader ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const presented = match[1]?.trim() ?? "";
  if (!presented) return null;

  let matchedEditorId: string | null = null;
  for (const [editorId, token] of Object.entries(tokenMap)) {
    if (constantTimeEquals(presented, token) && !matchedEditorId) {
      matchedEditorId = editorId;
    }
  }
  return matchedEditorId;
}

export function authorizeEditorRequest(
  req: Request,
  env: Pick<EnvConfig, "EDITOR_TOKEN" | "EDITOR_TOKENS_JSON">,
): EditorAuthResult {
  const tokenMap = resolveEditorTokenMap(env);
  const editorId = resolveEditorIdFromAuthorizationHeader(
    req.headers.get("authorization"),
    tokenMap,
  );
  if (!editorId) return { ok: false };
  return { ok: true, editorId };
}
