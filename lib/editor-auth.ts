import type { EnvConfig } from "./config";
import { createHmac } from "node:crypto";

const EDITOR_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const EDITOR_SESSION_COOKIE_VERSION = 1;
const EDITOR_SESSION_SIGNING_SALT = "la-editor-session:v1";

export const EDITOR_SESSION_COOKIE_NAME = "la_editor_session";
export const EDITOR_SESSION_MAX_AGE_SECONDS = 60 * 24 * 60 * 60;

interface EditorSessionClaims {
  v: number;
  editorId: string;
  exp: number;
  iat: number;
}

export type EditorAuthResult =
  | { ok: true; editorId: string; source: "bearer" | "cookie" }
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

function deriveSessionSigningKey(tokenMap: Record<string, string>): string {
  const canonical = Object.entries(tokenMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([editorId, token]) => `${editorId}:${token}`)
    .join("|");
  return createHmac("sha256", EDITOR_SESSION_SIGNING_SALT)
    .update(canonical)
    .digest("hex");
}

function parseCookieValue(cookieHeader: string | null, cookieName: string): string | null {
  if (!cookieHeader) return null;
  const chunks = cookieHeader.split(";");
  for (const rawChunk of chunks) {
    const chunk = rawChunk.trim();
    if (!chunk.startsWith(`${cookieName}=`)) continue;
    const value = chunk.slice(cookieName.length + 1).trim();
    if (!value) return null;
    return value;
  }
  return null;
}

function signEditorSessionPayload(payloadB64: string, signingKey: string): string {
  return createHmac("sha256", signingKey).update(payloadB64).digest("base64url");
}

function encodeEditorSessionClaims(claims: EditorSessionClaims): string {
  return Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
}

function decodeEditorSessionClaims(raw: string): EditorSessionClaims | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Partial<EditorSessionClaims>;
    if (obj.v !== EDITOR_SESSION_COOKIE_VERSION) return null;
    if (typeof obj.editorId !== "string" || !obj.editorId.trim()) return null;
    if (typeof obj.exp !== "number" || !Number.isFinite(obj.exp)) return null;
    if (typeof obj.iat !== "number" || !Number.isFinite(obj.iat)) return null;
    return {
      v: obj.v,
      editorId: obj.editorId.trim().toLowerCase(),
      exp: obj.exp,
      iat: obj.iat,
    };
  } catch {
    return null;
  }
}

function resolveEditorIdFromSessionCookie(
  req: Request,
  tokenMap: Record<string, string>,
): string | null {
  const rawCookie = parseCookieValue(
    req.headers.get("cookie"),
    EDITOR_SESSION_COOKIE_NAME,
  );
  if (!rawCookie) return null;
  const [payloadB64, signature] = rawCookie.split(".", 2);
  if (!payloadB64 || !signature) return null;
  const signingKey = deriveSessionSigningKey(tokenMap);
  const expectedSignature = signEditorSessionPayload(payloadB64, signingKey);
  if (!constantTimeEquals(signature, expectedSignature)) return null;
  const claims = decodeEditorSessionClaims(payloadB64);
  if (!claims) return null;
  if (claims.exp <= Date.now()) return null;
  if (!tokenMap[claims.editorId]) return null;
  return claims.editorId;
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

export function buildEditorSessionCookieValue(
  editorId: string,
  env: Pick<EnvConfig, "EDITOR_TOKEN" | "EDITOR_TOKENS_JSON">,
  nowMs: number = Date.now(),
): string {
  const tokenMap = resolveEditorTokenMap(env);
  if (!tokenMap[editorId]) {
    throw new Error(`Unknown editor id "${editorId}" for session cookie.`);
  }
  const claims: EditorSessionClaims = {
    v: EDITOR_SESSION_COOKIE_VERSION,
    editorId,
    iat: nowMs,
    exp: nowMs + (EDITOR_SESSION_MAX_AGE_SECONDS * 1000),
  };
  const payloadB64 = encodeEditorSessionClaims(claims);
  const signingKey = deriveSessionSigningKey(tokenMap);
  const signature = signEditorSessionPayload(payloadB64, signingKey);
  return `${payloadB64}.${signature}`;
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
  if (editorId) return { ok: true, editorId, source: "bearer" };
  const sessionEditorId = resolveEditorIdFromSessionCookie(req, tokenMap);
  if (!sessionEditorId) return { ok: false };
  return { ok: true, editorId: sessionEditorId, source: "cookie" };
}

export function isSameOriginEditorMutation(req: Request): boolean {
  const requestOrigin = new URL(req.url).origin;
  const originHeader = req.headers.get("origin")?.trim();
  if (originHeader) {
    return originHeader === requestOrigin;
  }
  const refererHeader = req.headers.get("referer")?.trim();
  if (!refererHeader) return false;
  try {
    return new URL(refererHeader).origin === requestOrigin;
  } catch {
    return false;
  }
}
