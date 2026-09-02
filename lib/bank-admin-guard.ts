import "server-only";
import { NextResponse } from "next/server";
import { getConfig } from "./config";
import { authorizeEditorRequest } from "./editor-auth";
import { isJeffEditorId } from "./job-time";
import { requestHasBankUnlock } from "./bank-pin";

export type BankAdminGuardResult =
  | { ok: true; editorId: string }
  | { ok: false; response: NextResponse };

/**
 * Both layers, in order, for every sensitive bank admin route:
 *   1. the existing editor session (unchanged), then
 *   2. the Bank PIN unlock cookie.
 *
 * Returns 401 `unauthorized` when the editor session is missing, 403 `forbidden`
 * for a non-Jeff editor, and 403 `bank_locked` when the editor is valid but this
 * device has not entered the Bank PIN. No bank data is produced in any of those
 * cases, and the configured PIN is never echoed back.
 *
 * Deliberately NOT applied to the Plaid webhook (verified by Plaid signature,
 * called by Plaid) or the scheduled sync route (called by the scheduler) —
 * adding a browser PIN there would break reconciliation.
 */
export function guardBankAdminRequest(request: Request): BankAdminGuardResult {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) {
    return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  if (!isJeffEditorId(auth.editorId)) {
    return { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  if (!env.BANK_ADMIN_PIN) {
    // Fail closed: with no PIN configured the bank admin surface stays locked
    // rather than silently falling back to editor-only protection.
    return {
      ok: false,
      response: NextResponse.json(
        { error: "bank_pin_not_configured", detail: "Set BANK_ADMIN_PIN to use the bank tools." },
        { status: 503 },
      ),
    };
  }
  if (!requestHasBankUnlock(request, env.BANK_ADMIN_PIN)) {
    return { ok: false, response: NextResponse.json({ error: "bank_locked" }, { status: 403 }) };
  }
  return { ok: true, editorId: auth.editorId };
}

/**
 * Minimal bolt-on for routes that already run their own editor check.
 * Returns a response when the bank is locked, or null to continue.
 */
export function requireBankUnlock(request: Request): NextResponse | null {
  const { env } = getConfig();
  if (!env.BANK_ADMIN_PIN) {
    return NextResponse.json(
      { error: "bank_pin_not_configured", detail: "Set BANK_ADMIN_PIN to use the bank tools." },
      { status: 503 },
    );
  }
  if (!requestHasBankUnlock(request, env.BANK_ADMIN_PIN)) {
    return NextResponse.json({ error: "bank_locked" }, { status: 403 });
  }
  return null;
}
