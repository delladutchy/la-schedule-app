/**
 * GET /api/quickbooks/status
 *
 * Jeff-only. Shows:
 *  - Feature flag and credential presence
 *  - Live OAuth connection test (token refresh)
 *  - Bootstrap cache state: customer + all 11 service items
 *  - readyToCreate: true only when everything is in place
 *
 * Use this after running POST /api/quickbooks/bootstrap to confirm setup.
 */

import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { checkQBConnection, readQBSetupCache } from "@/lib/quickbooks";
import { QB_LINE_NAMES, QB_REQUIRED_ITEM_KEYS } from "@/lib/quickbooks-types";

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
    realmId:      !!env.QUICKBOOKS_REALM_ID,
    refreshToken: !!env.QUICKBOOKS_REFRESH_TOKEN,
    customerName: env.QUICKBOOKS_CUSTOMER_NAME,
  };

  const missingCreds = Object.entries({
    clientId:     credentials.clientId,
    clientSecret: credentials.clientSecret,
    realmId:      credentials.realmId,
    refreshToken: credentials.refreshToken,
  })
    .filter(([, v]) => !v)
    .map(([k]) => `QUICKBOOKS_${k.replace(/([A-Z])/g, "_$1").toUpperCase()}`);

  // Live connection test (only when credentials are present)
  let connectionTest: { ok: boolean; error?: string } | null = null;
  const canTest = credentials.clientId && credentials.clientSecret && credentials.refreshToken;
  if (canTest) {
    connectionTest = await checkQBConnection(env);
  }

  // Bootstrap cache
  let setup = null;
  let setupItems: Record<string, { name: string; resolved: boolean; id: string | null }> = {};
  let bootstrappedAt: string | null = null;
  let customerResolved = false;

  if (env.QUICKBOOKS_REALM_ID) {
    setup = await readQBSetupCache(env.QUICKBOOKS_REALM_ID);
  }

  if (setup) {
    bootstrappedAt = setup.bootstrappedAt;
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

  const allItemsResolved = Object.values(setupItems).every((i) => i.resolved);
  const resolvedItemCount = Object.values(setupItems).filter((i) => i.resolved).length;

  const readyToCreate =
    enabled &&
    missingCreds.length === 0 &&
    connectionTest?.ok === true &&
    !!setup &&
    customerResolved &&
    allItemsResolved;

  return NextResponse.json({
    enabled,
    readyToCreate,
    credentials,
    missingCredentials: missingCreds.length > 0 ? missingCreds : null,
    connectionTest,
    bootstrap: {
      completed:    !!setup,
      bootstrappedAt,
      customer: setup
        ? { resolved: customerResolved, id: setup.customerId, name: setup.customerName }
        : { resolved: false, id: null, name: env.QUICKBOOKS_CUSTOMER_NAME },
      incomeAccount: setup?.incomeAccountRef ?? null,
      items: setupItems,
      resolvedItemCount,
      totalItemCount: QB_REQUIRED_ITEM_KEYS.length,
      allItemsResolved,
    },
    nextSteps: !setup
      ? ["POST /api/quickbooks/bootstrap to find or create QBO service items"]
      : !readyToCreate
      ? [
          !enabled           && "Set QUICKBOOKS_ENABLED=true",
          missingCreds.length > 0 && `Add env vars: ${missingCreds.join(", ")}`,
          !customerResolved  && `Create customer "${env.QUICKBOOKS_CUSTOMER_NAME}" in QBO → Customers`,
          !allItemsResolved  && "Re-run POST /api/quickbooks/bootstrap",
        ].filter(Boolean)
      : null,
  });
}
