/**
 * GET /api/quickbooks/connect
 *
 * Jeff-only. Initiates the QuickBooks OAuth 2.0 authorization flow.
 *
 * Flow:
 *  1. Verify Jeff's session cookie
 *  2. Generate a cryptographically random state value (CSRF protection)
 *  3. Store state in Supabase quickbooks_oauth_state (10-minute TTL)
 *  4. Redirect the browser to the Intuit authorization URL
 *
 * After the user approves access in Intuit, the browser is redirected to
 * /api/quickbooks/callback?code=...&state=...&realmId=...
 *
 * Prerequisites:
 *  - QUICKBOOKS_CLIENT_ID set in env
 *  - QUICKBOOKS_CLIENT_SECRET set in env
 *  - QUICKBOOKS_REDIRECT_URI set in env (must match Intuit app settings)
 *    e.g. https://your-site.netlify.app/api/quickbooks/callback
 *  - scripts/qb-migration.sql applied (quickbooks_oauth_state table)
 */

import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { buildQBAuthUrl } from "@/lib/quickbooks";
import { createOAuthState, pruneExpiredOAuthStates } from "@/lib/quickbooks-connection";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) {
    return NextResponse.redirect(new URL("/admin/quickbooks?error=unauthorized", request.url));
  }
  if (!isJeffEditorId(auth.editorId)) {
    return NextResponse.redirect(new URL("/admin/quickbooks?error=forbidden", request.url));
  }

  if (!env.QUICKBOOKS_CLIENT_ID) {
    return NextResponse.redirect(new URL("/admin/quickbooks?error=missing_client_id", request.url));
  }
  if (!env.QUICKBOOKS_CLIENT_SECRET) {
    return NextResponse.redirect(new URL("/admin/quickbooks?error=missing_client_secret", request.url));
  }
  if (!env.QUICKBOOKS_REDIRECT_URI) {
    return NextResponse.redirect(new URL("/admin/quickbooks?error=missing_redirect_uri", request.url));
  }

  // Best-effort cleanup of old state rows (non-blocking)
  pruneExpiredOAuthStates().catch(() => undefined);

  // Generate and store CSRF state
  const state = await createOAuthState(auth.editorId);

  // Redirect to Intuit
  const authUrl = buildQBAuthUrl(env.QUICKBOOKS_CLIENT_ID, env.QUICKBOOKS_REDIRECT_URI, state);
  return NextResponse.redirect(authUrl);
}
