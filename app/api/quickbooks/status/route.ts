/**
 * GET /api/quickbooks/status
 *
 * Jeff-only debug endpoint. Returns:
 *  - Whether the feature flag is on
 *  - Which required env vars are present vs. missing
 *  - Which QB item IDs are configured
 *  - A live connection test (token refresh) when credentials are present
 *
 * Use this to confirm QB is ready before flipping QUICKBOOKS_ENABLED=true.
 */

import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { checkQBConnection, getQBItemConfig } from "@/lib/quickbooks";
import { QB_LINE_NAMES } from "@/lib/quickbooks-types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isJeffEditorId(auth.editorId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const enabled = !!env.QUICKBOOKS_ENABLED;

  // Credential presence (values never returned, only booleans)
  const credentials = {
    clientId:     !!env.QUICKBOOKS_CLIENT_ID,
    clientSecret: !!env.QUICKBOOKS_CLIENT_SECRET,
    redirectUri:  !!env.QUICKBOOKS_REDIRECT_URI,
    realmId:      !!env.QUICKBOOKS_REALM_ID,
    refreshToken: !!env.QUICKBOOKS_REFRESH_TOKEN,
    customerId:   !!env.QUICKBOOKS_CUSTOMER_ID,
  };

  const missing = Object.entries(credentials)
    .filter(([, v]) => !v)
    .map(([k]) => `QUICKBOOKS_${k.replace(/([A-Z])/g, "_$1").toUpperCase()}`);

  // Item ID configuration
  const rawItems = getQBItemConfig();
  const itemIds = Object.fromEntries(
    (Object.keys(rawItems) as Array<keyof typeof rawItems>).map((key) => [
      key,
      {
        label:       QB_LINE_NAMES[key],
        configured:  rawItems[key] !== null,
        envVar:      `QUICKBOOKS_ITEM_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}`,
      },
    ]),
  ) as Record<string, { label: string; configured: boolean; envVar: string }>;

  const allItemsConfigured = Object.values(itemIds).every((i) => i.configured);
  const configuredItemCount = Object.values(itemIds).filter((i) => i.configured).length;

  // Live connection test — only when credentials are present (avoids noisy errors)
  let connectionTest: { ok: boolean; error?: string } | null = null;
  const canTest = credentials.clientId && credentials.clientSecret && credentials.refreshToken;
  if (canTest) {
    connectionTest = await checkQBConnection(env);
  }

  // Supabase migration note
  const migrationRequired =
    "Run scripts/qb-migration.sql against your Supabase project to add QB columns " +
    "(quickbooks_invoice_id, quickbooks_invoice_link, quickbooks_synced_at, quickbooks_sync_error).";

  return NextResponse.json({
    enabled,
    readyToCreate: enabled && missing.length === 0 && allItemsConfigured && connectionTest?.ok === true,
    credentials,
    missing: missing.length > 0 ? missing : null,
    itemIds,
    allItemsConfigured,
    configuredItemCount,
    totalItemCount: Object.keys(itemIds).length,
    connectionTest,
    notes: {
      migration: migrationRequired,
      oauthFlow:
        "To obtain QUICKBOOKS_REFRESH_TOKEN, complete the OAuth 2.0 flow via " +
        "https://developer.intuit.com/app/developer/playground",
    },
  });
}
