/**
 * GET /api/quickbooks/status
 *
 * Jeff-only. Comprehensive status check:
 *
 *   connection   — realm_id stored, refresh_token stored, connected_at
 *   credentials  — which env vars are present
 *   tokenTest    — live OAuth token refresh (verifies credentials + refresh token work)
 *   bootstrap    — item IDs cached, customer resolved, all items resolved
 *   readyToCreate — true only when all requirements are met
 *
 * Does NOT return secret values (tokens, secrets). Only booleans and metadata.
 */

import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { checkQBConnection, readQBSetupCache } from "@/lib/quickbooks";
import { getQBConnection } from "@/lib/quickbooks-connection";
import { QB_LINE_NAMES, QB_REQUIRED_ITEM_KEYS } from "@/lib/quickbooks-types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isJeffEditorId(auth.editorId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const enabled = !!env.QUICKBOOKS_ENABLED;

  // ── Credentials (env vars) ──────────────────────────────────────────────────
  const credentials = {
    clientId:     !!env.QUICKBOOKS_CLIENT_ID,
    clientSecret: !!env.QUICKBOOKS_CLIENT_SECRET,
    redirectUri:  !!env.QUICKBOOKS_REDIRECT_URI,
    customerName: env.QUICKBOOKS_CUSTOMER_NAME,
    realmIdEnv:   !!env.QUICKBOOKS_REALM_ID,     // optional override
    refreshTokenEnv: !!env.QUICKBOOKS_REFRESH_TOKEN, // optional override
  };

  const missingRequiredCreds = [
    !credentials.clientId     && "QUICKBOOKS_CLIENT_ID",
    !credentials.clientSecret && "QUICKBOOKS_CLIENT_SECRET",
    !credentials.redirectUri  && "QUICKBOOKS_REDIRECT_URI",
  ].filter(Boolean) as string[];

  // ── DB connection ───────────────────────────────────────────────────────────
  const dbConn = await getQBConnection();
  const connection = dbConn
    ? {
        stored:                true,
        realmId:               maskSecret(dbConn.realmId),
        refreshTokenStored:    true,
        refreshTokenExpiresAt: dbConn.refreshTokenExpiresAt,
        connectedAt:           dbConn.connectedAt,
        connectedBy:           dbConn.connectedBy,
      }
    : {
        stored:             false,
        realmId:            env.QUICKBOOKS_REALM_ID ? "(env var)" : null,
        refreshTokenStored: !!env.QUICKBOOKS_REFRESH_TOKEN,
        connectedAt:        null,
        connectedBy:        null,
      };

  // Resolve effective realm ID for setup cache lookup
  const effectiveRealmId = dbConn?.realmId ?? env.QUICKBOOKS_REALM_ID ?? null;

  // ── Live token test ─────────────────────────────────────────────────────────
  let tokenTest: { ok: boolean; error?: string } | null = null;
  const canTest = credentials.clientId && credentials.clientSecret &&
    (!!dbConn || !!env.QUICKBOOKS_REFRESH_TOKEN);
  if (canTest) {
    tokenTest = await checkQBConnection(env);
  }

  // ── Bootstrap cache ─────────────────────────────────────────────────────────
  let setupItems: Record<string, { name: string; resolved: boolean; id: string | null }> = {};
  let bootstrappedAt: string | null = null;
  let customerResolved = false;
  let setup = null;

  if (effectiveRealmId) {
    setup = await readQBSetupCache(effectiveRealmId);
  }

  if (setup) {
    bootstrappedAt  = setup.bootstrappedAt;
    customerResolved = !!setup.customerId;
    setupItems = Object.fromEntries(
      QB_REQUIRED_ITEM_KEYS.map((key) => [
        key,
        {
          name:     QB_LINE_NAMES[key],
          resolved: !!setup!.itemIds[key],
          id:       setup!.itemIds[key] ?? null,
        },
      ]),
    );
  } else {
    setupItems = Object.fromEntries(
      QB_REQUIRED_ITEM_KEYS.map((key) => [
        key,
        { name: QB_LINE_NAMES[key], resolved: false, id: null },
      ]),
    );
  }

  const allItemsResolved    = Object.values(setupItems).every((i) => i.resolved);
  const resolvedItemCount   = Object.values(setupItems).filter((i) => i.resolved).length;

  // ── readyToCreate ───────────────────────────────────────────────────────────
  const hasConnection = !!dbConn || !!env.QUICKBOOKS_REFRESH_TOKEN;
  const readyToCreate =
    enabled &&
    missingRequiredCreds.length === 0 &&
    hasConnection &&
    tokenTest?.ok === true &&
    !!setup &&
    customerResolved &&
    allItemsResolved;

  // ── Next-steps hints ────────────────────────────────────────────────────────
  const nextSteps: string[] = [];
  if (!credentials.clientId || !credentials.clientSecret)
    nextSteps.push("Add QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET to env vars");
  if (!credentials.redirectUri)
    nextSteps.push("Add QUICKBOOKS_REDIRECT_URI to env vars (e.g. https://…/api/quickbooks/callback)");
  if (!hasConnection)
    nextSteps.push("Visit /admin/quickbooks and click 'Connect to QuickBooks'");
  if (hasConnection && tokenTest && !tokenTest.ok)
    nextSteps.push("OAuth token is invalid or expired — reconnect at /admin/quickbooks");
  if (hasConnection && tokenTest?.ok && !setup)
    nextSteps.push("POST /api/quickbooks/bootstrap to resolve QBO items and customer");
  if (setup && !customerResolved)
    nextSteps.push(`Create customer "${env.QUICKBOOKS_CUSTOMER_NAME}" in QBO → Customers`);
  if (setup && !allItemsResolved)
    nextSteps.push("Re-run POST /api/quickbooks/bootstrap to create missing items");
  if (!enabled && readyToCreate)
    nextSteps.push("Set QUICKBOOKS_ENABLED=true to enable draft invoice creation");

  return NextResponse.json({
    enabled,
    readyToCreate,
    credentials,
    missingRequiredCredentials: missingRequiredCreds.length > 0 ? missingRequiredCreds : null,
    connection,
    tokenTest,
    bootstrap: {
      completed:       !!setup,
      bootstrappedAt,
      customer: setup
        ? { resolved: customerResolved, id: setup.customerId, name: setup.customerName }
        : { resolved: false, id: null, name: env.QUICKBOOKS_CUSTOMER_NAME },
      incomeAccount:      setup?.incomeAccountRef ?? null,
      items:              setupItems,
      resolvedItemCount,
      totalItemCount:     QB_REQUIRED_ITEM_KEYS.length,
      allItemsResolved,
    },
    nextSteps: nextSteps.length > 0 ? nextSteps : null,
  });
}

function maskSecret(value: string): string {
  if (value.length <= 4) return "****";
  return `****${value.slice(-4)}`;
}
