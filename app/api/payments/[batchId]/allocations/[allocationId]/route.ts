/**
 * DELETE /api/payments/[batchId]/allocations/[allocationId]
 *
 * Removes a single allocation and recomputes the invoice's payment totals.
 * Body: { google_event_id, invoice_total }  — needed for recalculation.
 */
import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { deleteAllocation } from "@/lib/payment-batches";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: NextRequest,
  { params }: { params: { batchId: string; allocationId: string } },
): Promise<NextResponse> {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isJeffEditorId(auth.editorId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: { google_event_id: string; invoice_total: number };
  try { body = await request.json() as typeof body; }
  catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }

  if (!body.google_event_id || body.invoice_total == null) {
    return NextResponse.json(
      { error: "validation_failed", detail: "google_event_id and invoice_total required" },
      { status: 400 },
    );
  }

  const totals = await deleteAllocation(
    params.allocationId,
    body.google_event_id,
    body.invoice_total,
  );

  return NextResponse.json({ ok: true, ...totals });
}
