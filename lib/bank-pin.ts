import "server-only";
import { createHmac } from "node:crypto";

/**
 * Bank PIN unlock — an ADDITIONAL layer on top of the existing editor session.
 *
 * The editor session still gates every bank route exactly as before. This adds
 * a short-lived 4-digit unlock so that a device already carrying the long-lived
 * editor cookie must still confirm before bank data is served. It is not a
 * login: no usernames, no accounts, no second identity provider.
 *
 * The PIN itself lives only in the BANK_ADMIN_PIN server environment variable.
 * It is never rendered, never returned by an API, never logged, and never
 * reaches the client bundle. Only a signed unlock cookie crosses the wire.
 */

const BANK_UNLOCK_COOKIE_VERSION = 1;
const BANK_UNLOCK_SIGNING_SALT = "la-bank-unlock:v1";

export const BANK_UNLOCK_COOKIE_NAME = "la_bank_unlock";
export const BANK_UNLOCK_MAX_AGE_SECONDS = 12 * 60 * 60; // 12 hours

export const BANK_PIN_PATTERN = /^\d{4}$/;

interface BankUnlockClaims {
  v: number;
  exp: number;
  iat: number;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Signing key is derived from the configured PIN, so changing BANK_ADMIN_PIN in
 * Netlify immediately invalidates every outstanding unlock cookie.
 */
function deriveUnlockSigningKey(pin: string): string {
  return createHmac("sha256", BANK_UNLOCK_SIGNING_SALT).update(pin).digest("hex");
}

function signPayload(payloadB64: string, signingKey: string): string {
  return createHmac("sha256", signingKey).update(payloadB64).digest("base64url");
}

function parseCookieValue(cookieHeader: string | null, cookieName: string): string | null {
  if (!cookieHeader) return null;
  for (const rawChunk of cookieHeader.split(";")) {
    const chunk = rawChunk.trim();
    if (!chunk.startsWith(`${cookieName}=`)) continue;
    const value = chunk.slice(cookieName.length + 1).trim();
    return value || null;
  }
  return null;
}

/** True when the configured PIN matches. Constant-time; never logs the input. */
export function isCorrectBankPin(candidate: string, configuredPin: string | undefined): boolean {
  if (!configuredPin || !BANK_PIN_PATTERN.test(configuredPin)) return false;
  if (!BANK_PIN_PATTERN.test(candidate)) return false;
  return constantTimeEquals(candidate, configuredPin);
}

export function buildBankUnlockCookieValue(configuredPin: string, nowMs: number = Date.now()): string {
  const claims: BankUnlockClaims = {
    v: BANK_UNLOCK_COOKIE_VERSION,
    iat: nowMs,
    exp: nowMs + BANK_UNLOCK_MAX_AGE_SECONDS * 1000,
  };
  const payloadB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payloadB64}.${signPayload(payloadB64, deriveUnlockSigningKey(configuredPin))}`;
}

/** Validate a raw cookie value against the configured PIN and expiry. */
export function isValidBankUnlockCookie(
  rawCookie: string | null,
  configuredPin: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!rawCookie || !configuredPin) return false;
  const [payloadB64, signature] = rawCookie.split(".", 2);
  if (!payloadB64 || !signature) return false;
  const expected = signPayload(payloadB64, deriveUnlockSigningKey(configuredPin));
  if (!constantTimeEquals(signature, expected)) return false;
  let claims: BankUnlockClaims;
  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as Partial<BankUnlockClaims>;
    if (parsed.v !== BANK_UNLOCK_COOKIE_VERSION) return false;
    if (typeof parsed.exp !== "number" || typeof parsed.iat !== "number") return false;
    claims = parsed as BankUnlockClaims;
  } catch {
    return false;
  }
  return claims.exp > nowMs;
}

/** Read the unlock cookie off a request and validate it. */
export function requestHasBankUnlock(req: Request, configuredPin: string | undefined): boolean {
  return isValidBankUnlockCookie(
    parseCookieValue(req.headers.get("cookie"), BANK_UNLOCK_COOKIE_NAME),
    configuredPin,
  );
}

// ---------------------------------------------------------------------------
// Guess throttling
// ---------------------------------------------------------------------------

/**
 * Best-effort in-memory throttle. Serverless instances are ephemeral, so this
 * is a speed bump rather than a guarantee — the real barrier is that an
 * attacker must already hold the editor session to reach this endpoint at all.
 */
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

interface AttemptRecord { failures: number[]; lockedUntil: number }
const attempts = new Map<string, AttemptRecord>();

export function bankPinLockoutRemainingMs(key: string, nowMs: number = Date.now()): number {
  const rec = attempts.get(key);
  if (!rec) return 0;
  return rec.lockedUntil > nowMs ? rec.lockedUntil - nowMs : 0;
}

export function recordBankPinFailure(key: string, nowMs: number = Date.now()): void {
  const rec = attempts.get(key) ?? { failures: [], lockedUntil: 0 };
  rec.failures = rec.failures.filter((t) => nowMs - t < WINDOW_MS);
  rec.failures.push(nowMs);
  if (rec.failures.length >= MAX_ATTEMPTS) {
    rec.lockedUntil = nowMs + LOCKOUT_MS;
    rec.failures = [];
  }
  attempts.set(key, rec);
}

export function clearBankPinFailures(key: string): void {
  attempts.delete(key);
}

/** Test seam only. */
export function __resetBankPinThrottle(): void {
  attempts.clear();
}
