/**
 * POST /api/quickbooks/bootstrap
 *
 * Jeff-only. One-time (or re-runnable) setup that:
 *  1. Gets an OAuth access token via stored refresh token
 *  2. Queries QBO Products & Services for each required item by name
 *  3. Creates any missing items automatically (uses first Income account)
 *  4. Looks up the customer by QUICKBOOKS_CUSTOMER_NAME
 *  5. Caches all resolved IDs in Supabase quickbooks_setup table
 *
 * Safe to re-run: existing items are matched by name, not re-created.
 * Customer is NEVER auto-created — must exist in QBO first.
 *
 * Prerequisites:
 *  - scripts/qb-migration.sql applied to Supabase
 *  - QUICKBOOKS_CLIENT_ID, CLIENT_SECRET, REALM_ID, REFRESH_TOKEN set
 *
 * After this succeeds, POST /api/quickbooks/draft/:eventId will work
 * without any QUICKBOOKS_ITEM_* env vars.
 */

import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { runQBBootstrap } from "@/lib/quickbooks";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isJeffEditorId(auth.editorId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const result = await runQBBootstrap(env).catch((err) => ({
    ok: false as const,
    errors: [err instanceof Error ? err.message : String(err)],
    customer: { found: false, id: null, name: env.QUICKBOOKS_CUSTOMER_NAME },
    items: {},
    incomeAccount: { found: false, id: null, name: null },
    cached: false,
  }));

  const status = result.ok ? 200 : 207; // 207 Multi-Status for partial success
  return NextResponse.json(result, { status });
}
