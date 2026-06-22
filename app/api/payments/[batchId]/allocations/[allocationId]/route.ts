/**
 * DELETE /api/payments/[batchId]/allocations/[allocationId]
 *
 * Removes a single allocation and recomputes the invoice's payment totals.
 * Body: { google_event_id, invoice_total }  — needed for recalculation.
 *
 * After a successful recalc, syncs the invoice's Google Sheet row (best-effort).
 */
import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { deleteAllocation, getLatestPaymentMeta } from "@/lib/payment-batches";
import { getInvoiceData } from "@/lib/invoice-data";
import { updateSheetPaymentColumns } from "@/lib/google-sheets";

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

  // Best-effort: sync updated payment status to Google Sheets.
  void syncPaymentSheet(body.google_event_id);

  return NextResponse.json({ ok: true, ...totals });
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
    console.error(`[payments/allocation/delete] sheet sync failed (non-fatal): ${err instanceof Error ? err.message : err}`);
  }
}
