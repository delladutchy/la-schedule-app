/**
 * GET /api/quickbooks/callback
 *
 * OAuth 2.0 callback from Intuit. NOT called directly — Intuit redirects
 * the user's browser here after they approve access.
 *
 * Query parameters (set by Intuit):
 *   code    — authorization code to exchange for tokens
 *   state   — must match the state we stored in quickbooks_oauth_state
 *   realmId — the QuickBooks company ID
 *   error   — present when the user denied access (e.g. "access_denied")
 *
 * Flow:
 *  1. Check for Intuit error (user denied access)
 *  2. Verify state against Supabase (CSRF protection, one-time use)
 *  3. Verify the editor who started the flow is Jeff
 *  4. Exchange authorization code for access + refresh tokens
 *  5. Store realm_id + refresh_token in Supabase quickbooks_connection
 *  6. Redirect to /admin/quickbooks?connected=true
 *
 * Security notes:
 *  - State is one-time: deleted from Supabase immediately on verification
 *  - Tokens are never logged or returned to the browser
 *  - The session cookie validates that the browser belongs to Jeff
 */

import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { isJeffEditorId } from "@/lib/job-time";
import { exchangeQBAuthCode } from "@/lib/quickbooks";
import { saveQBConnection, verifyAndConsumeOAuthState } from "@/lib/quickbooks-connection";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { env } = getConfig();
  const { searchParams } = new URL(request.url);

  const adminBase = new URL("/admin/quickbooks", request.url);

  // Intuit returned an error (user denied access or other issue)
  const intuitError = searchParams.get("error");
  if (intuitError) {
    adminBase.searchParams.set("error", `intuit_${intuitError}`);
    return NextResponse.redirect(adminBase.toString());
  }

  const code    = searchParams.get("code") ?? "";
  const state   = searchParams.get("state") ?? "";
  const realmId = searchParams.get("realmId") ?? "";

  if (!code || !state || !realmId) {
    adminBase.searchParams.set("error", "missing_params");
    return NextResponse.redirect(adminBase.toString());
  }

  // Verify CSRF state (one-time, expires in 10 minutes)
  const editorId = await verifyAndConsumeOAuthState(state);
  if (!editorId) {
    adminBase.searchParams.set("error", "invalid_state");
    return NextResponse.redirect(adminBase.toString());
  }

  // Only Jeff can complete the OAuth flow
  if (!isJeffEditorId(editorId)) {
    adminBase.searchParams.set("error", "forbidden");
    return NextResponse.redirect(adminBase.toString());
  }

  if (!env.QUICKBOOKS_CLIENT_ID || !env.QUICKBOOKS_CLIENT_SECRET || !env.QUICKBOOKS_REDIRECT_URI) {
    adminBase.searchParams.set("error", "missing_env_vars");
    return NextResponse.redirect(adminBase.toString());
  }

  // Exchange authorization code for tokens
  let tokens: Awaited<ReturnType<typeof exchangeQBAuthCode>>;
  try {
    tokens = await exchangeQBAuthCode(
      code,
      env.QUICKBOOKS_REDIRECT_URI,
      env.QUICKBOOKS_CLIENT_ID,
      env.QUICKBOOKS_CLIENT_SECRET,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Do not log msg here — it may contain partial token data
    console.error("[qb-callback] token exchange failed");
    adminBase.searchParams.set("error", "token_exchange_failed");
    adminBase.searchParams.set("detail", encodeURIComponent(msg.slice(0, 120)));
    return NextResponse.redirect(adminBase.toString());
  }

  // Store connection (tokens never returned to client)
  try {
    await saveQBConnection({
      realmId,
      refreshToken:            tokens.refreshToken,
      refreshTokenExpiresAt:   tokens.refreshTokenExpiresAt,
      connectedAt:             new Date().toISOString(),
      connectedBy:             editorId,
    });
  } catch (err) {
    console.error("[qb-callback] saveQBConnection failed:", err instanceof Error ? err.message : err);
    adminBase.searchParams.set("error", "save_failed");
    return NextResponse.redirect(adminBase.toString());
  }

  adminBase.searchParams.set("connected", "true");
  return NextResponse.redirect(adminBase.toString());
}
