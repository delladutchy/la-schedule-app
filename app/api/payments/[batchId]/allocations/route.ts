/**
 * GET  /api/payments/[batchId]/allocations  — list allocations for a batch
 * POST /api/payments/[batchId]/allocations  — create allocation + update invoice payment totals
 *
 * Body (POST):
 *   google_event_id   — the invoice's event ID
 *   allocated_amount  — dollar amount to allocate (must be > 0)
 *   invoice_total     — current invoice total (used for recalculation)
 *
 * After a successful recalc, syncs the invoice's Google Sheet row (best-effort).
 */
import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { createAllocation, listAllocationsForBatch, getLatestPaymentMeta } from "@/lib/payment-batches";
import { getInvoiceData } from "@/lib/invoice-data";
import { updateSheetPaymentColumns } from "@/lib/google-sheets";

export const dynamic = "force-dynamic";

function jeffOnly(request: NextRequest) {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return { ok: false as const, status: 401 as const };
  if (!isJeffEditorId(auth.editorId)) return { ok: false as const, status: 403 as const };
  return { ok: true as const };
}

export async function GET(
  request: NextRequest,
  { params }: { params: { batchId: string } },
): Promise<NextResponse> {
  const auth = jeffOnly(request);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: auth.status });

  const allocations = await listAllocationsForBatch(params.batchId);
  return NextResponse.json({ allocations });
}

export async function POST(
  request: NextRequest,
  { params }: { params: { batchId: string } },
): Promise<NextResponse> {
  const auth = jeffOnly(request);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: auth.status });

  let body: { google_event_id: string; allocated_amount: number; invoice_total: number };
  try { body = await request.json() as typeof body; }
  catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }

  if (!body.google_event_id || !body.allocated_amount || body.allocated_amount <= 0) {
    return NextResponse.json(
      { error: "validation_failed", detail: "google_event_id and allocated_amount (> 0) required" },
      { status: 400 },
    );
  }
  if (!body.invoice_total || body.invoice_total <= 0) {
    return NextResponse.json(
      { error: "validation_failed", detail: "invoice_total (> 0) required for recalculation" },
      { status: 400 },
    );
  }

  const result = await createAllocation(
    {
      payment_batch_id: params.batchId,
      google_event_id:  body.google_event_id,
      allocated_amount: body.allocated_amount,
    },
    body.invoice_total,
  );

  // Best-effort: sync updated payment status to Google Sheets.
  // Failures are logged but do not roll back the allocation.
  await syncPaymentSheet(body.google_event_id);

  return NextResponse.json(result, { status: 201 });
}

async function syncPaymentSheet(googleEventId: string): Promise<void> {
  try {
    const [invoiceData, paymentMeta] = await Promise.all([
      getInvoiceData(googleEventId),
      getLatestPaymentMeta(googleEventId),
    ]);

    if (!invoiceData?.la_number && !invoiceData?.invoice_number) return;

    await updateSheetPaymentColumns({
      laJobNumber:         invoiceData.la_number ?? "",
      invoiceNumber:       invoiceData.invoice_number ?? "",
      status:              invoiceData.invoice_status,
      paidDate:            invoiceData.paid_date ?? "",
      invoicePdfUrl:       invoiceData.invoice_pdf_url ?? "",
      invoiceSentDate:     invoiceData.invoice_sent_at ? invoiceData.invoice_sent_at.slice(0, 10) : "",
      amountPaid:          invoiceData.amount_paid,
      remainingBalance:    invoiceData.remaining_balance ?? 0,
      paymentMethod:       paymentMeta.paymentMethod,
      paymentReceivedDate: paymentMeta.paymentReceivedDate,
      paymentBatchRef:     paymentMeta.paymentBatchRef,
    });
  } catch (err) {
    console.error(`[payments/allocation] sheet sync failed (non-fatal): ${err instanceof Error ? err.message : err}`);
  }
}
