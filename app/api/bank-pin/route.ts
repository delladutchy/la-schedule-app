/**
 * Bank PIN unlock/lock.
 *
 *   GET    — is this device currently unlocked? (no bank data, no PIN echo)
 *   POST   — exchange a correct 4-digit PIN for a 12-hour httpOnly cookie
 *   DELETE — "Lock Bank": clears ONLY the bank unlock cookie
 *
 * The editor session is required for all three and is never modified here, so
 * locking the bank never signs you out of LA Schedule.
 */

import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest, isSameOriginEditorMutation } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import {
  BANK_UNLOCK_COOKIE_NAME,
  BANK_UNLOCK_MAX_AGE_SECONDS,
  BANK_PIN_PATTERN,
  bankPinLockoutRemainingMs,
  buildBankUnlockCookieValue,
  clearBankPinFailures,
  isCorrectBankPin,
  recordBankPinFailure,
  requestHasBankUnlock,
} from "@/lib/bank-pin";

export const dynamic = "force-dynamic";

function secureCookies() {
  return process.env.NODE_ENV === "production";
}

function requireEditor(request: NextRequest) {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return { ok: false as const, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }), env };
  if (!isJeffEditorId(auth.editorId)) return { ok: false as const, response: NextResponse.json({ error: "forbidden" }, { status: 403 }), env };
  return { ok: true as const, editorId: auth.editorId, env };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const gate = requireEditor(request);
  if (!gate.ok) return gate.response;
  return NextResponse.json({
    configured: Boolean(gate.env.BANK_ADMIN_PIN),
    unlocked: requestHasBankUnlock(request, gate.env.BANK_ADMIN_PIN),
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const gate = requireEditor(request);
  if (!gate.ok) return gate.response;
  if (!isSameOriginEditorMutation(request)) {
    return NextResponse.json({ error: "forbidden_origin" }, { status: 403 });
  }
  const configuredPin = gate.env.BANK_ADMIN_PIN;
  if (!configuredPin) {
    return NextResponse.json(
      { error: "bank_pin_not_configured", detail: "Set BANK_ADMIN_PIN to use the bank tools." },
      { status: 503 },
    );
  }

  const throttleKey = gate.editorId;
  const lockedFor = bankPinLockoutRemainingMs(throttleKey);
  if (lockedFor > 0) {
    return NextResponse.json(
      { error: "too_many_attempts", retryAfterSeconds: Math.ceil(lockedFor / 1000) },
      { status: 429 },
    );
  }

  let pin = "";
  try {
    const body = await request.json() as { pin?: unknown };
    pin = typeof body.pin === "string" ? body.pin.trim() : "";
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!BANK_PIN_PATTERN.test(pin)) {
    // Shape failure only — the entered value is never logged or echoed.
    return NextResponse.json({ error: "invalid_pin" }, { status: 400 });
  }

  if (!isCorrectBankPin(pin, configuredPin)) {
    recordBankPinFailure(throttleKey);
    // Small fixed delay to blunt rapid guessing.
    await new Promise((resolve) => setTimeout(resolve, 400));
    console.warn("[bank-pin] incorrect PIN attempt");
    return NextResponse.json({ error: "incorrect_pin" }, { status: 401 });
  }

  clearBankPinFailures(throttleKey);
  const response = NextResponse.json({ ok: true, unlocked: true });
  response.cookies.set({
    name: BANK_UNLOCK_COOKIE_NAME,
    value: buildBankUnlockCookieValue(configuredPin),
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: BANK_UNLOCK_MAX_AGE_SECONDS,
  });
  console.info("[bank-pin] bank unlocked");
  return response;
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const gate = requireEditor(request);
  if (!gate.ok) return gate.response;
  const response = NextResponse.json({ ok: true, unlocked: false });
  // Clears the bank unlock only. The editor session cookie is untouched.
  response.cookies.set({
    name: BANK_UNLOCK_COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
