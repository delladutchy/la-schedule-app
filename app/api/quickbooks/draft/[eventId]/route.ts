/**
 * POST /api/quickbooks/draft/:eventId
 *
 * Jeff-only. Creates a draft invoice in QuickBooks Online for the given event.
 *
 * Prerequisites:
 *  1. QUICKBOOKS_ENABLED=true
 *  2. OAuth credentials in env (CLIENT_ID, CLIENT_SECRET, REALM_ID, REFRESH_TOKEN)
 *  3. POST /api/quickbooks/bootstrap completed successfully
 *  4. scripts/qb-migration.sql applied to Supabase
 *
 * Workflow:
 *  1. Load invoice_data from Supabase
 *  2. Calculate InvoicePacket
 *  3. Load bootstrapped QB item IDs + customer from Supabase cache
 *  4. Build QB invoice lines
 *  5. POST draft invoice to QBO (not sent to client)
 *  6. Store QB invoice ID + link back on invoice_data
 *  7. Return { invoiceId, docNumber, totalAmount, link }
 *
 * Body (JSON, optional):
 *  { gigSummary?: string }   — appears as PrivateNote on the QB invoice
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

  if (!env.QUICKBOOKS_ENABLED) {
    return NextResponse.json(
      {
        error: "quickbooks_not_enabled",
        message: "Set QUICKBOOKS_ENABLED=true once OAuth and bootstrap are complete.",
        statusUrl: "/api/quickbooks/status",
      },
      { status: 503 },
    );
  }

  const { eventId } = params;
  const data = await getInvoiceData(eventId);
  if (!data) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = await request.json().catch(() => ({})) as { gigSummary?: string };
  const packet = calculateInvoicePacket(data);

  try {
    const result = await createQBDraftInvoice(packet, body.gigSummary ?? "", env);

    // Persist QB invoice ID + link — requires scripts/qb-migration.sql
    await markQBDraftCreated(eventId, result.invoiceId, result.link);

    return NextResponse.json({
      ok:          true,
      invoiceId:   result.invoiceId,
      docNumber:   result.docNumber,
      totalAmount: result.totalAmount,
      link:        result.link,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markQBSyncError(eventId, message).catch(() => undefined);
    return NextResponse.json({ error: "qb_error", message }, { status: 502 });
  }
}
