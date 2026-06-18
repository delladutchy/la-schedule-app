/**
 * POST /api/quickbooks/draft/:eventId
 *
 * Jeff-only. Creates a draft invoice in QuickBooks Online for the given event.
 *
 * Prerequisites (check /api/quickbooks/status first):
 *   1. QUICKBOOKS_ENABLED=true
 *   2. OAuth credentials present (CLIENT_ID, CLIENT_SECRET, REALM_ID, REFRESH_TOKEN)
 *   3. At least the core QUICKBOOKS_ITEM_* env vars set
 *   4. scripts/qb-migration.sql applied to Supabase (for writing QB fields back)
 *
 * Workflow:
 *   1. Load invoice_data from Supabase
 *   2. Calculate InvoicePacket
 *   3. Build QB invoice lines
 *   4. POST to QBO API (draft — not sent to client)
 *   5. Store QB invoice ID + link back on invoice_data
 *   6. Return { invoiceId, docNumber, totalAmount, link }
 *
 * Request body (JSON, optional):
 *   { gigSummary?: string }   — appears as PrivateNote on the QB invoice
 */

import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { getInvoiceData, markQBDraftCreated, markQBSyncError } from "@/lib/invoice-data";
import { calculateInvoicePacket } from "@/lib/invoice-calculations";
import { createQBDraftInvoice } from "@/lib/quickbooks";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: { eventId: string } },
) {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isJeffEditorId(auth.editorId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  // Gate — feature flag must be explicitly enabled
  if (!env.QUICKBOOKS_ENABLED) {
    return NextResponse.json(
      {
        error: "quickbooks_not_enabled",
        message: "Set QUICKBOOKS_ENABLED=true once OAuth setup is complete.",
        statusUrl: "/api/quickbooks/status",
      },
      { status: 503 },
    );
  }

  const { eventId } = params;
  const data = await getInvoiceData(eventId);
  if (!data) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({})) as { gigSummary?: string };
  const packet = calculateInvoicePacket(data, body.gigSummary);

  try {
    const result = await createQBDraftInvoice(packet, body.gigSummary ?? "", env);

    // Persist QB invoice ID + link back to Supabase.
    // Requires scripts/qb-migration.sql — if columns don't exist this will throw.
    await markQBDraftCreated(eventId, result.invoiceId, result.link);

    return NextResponse.json({
      ok: true,
      invoiceId:   result.invoiceId,
      docNumber:   result.docNumber,
      totalAmount: result.totalAmount,
      link:        result.link,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Best-effort: record the error on the invoice row
    await markQBSyncError(eventId, message).catch(() => undefined);
    return NextResponse.json({ error: "qb_error", message }, { status: 502 });
  }
}
