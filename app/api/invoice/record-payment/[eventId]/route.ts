/**
 * POST /api/invoice/record-payment/[eventId]
 *
 * Records that a payment was received for a job — no Gmail draft, no PDF,
 * no email of any kind.  Use this for historical jobs and payments received
 * outside the app (direct deposits, checks, etc.).
 *
 * Body:
 *   amount_paid     — dollar amount received (required, > 0)
 *   paid_date       — YYYY-MM-DD when payment was received (required)
 *   payment_method  — optional, defaults to "Direct Deposit"
 *   reference       — optional memo / check number / note
 *   invoice_total   — required ONLY when no invoice_total is stored yet
 *
 * Effects:
 *   1. Creates a payment_batch row (client_name="Light Action", received_date=paid_date)
 *   2. Creates a payment_batch_allocation linking batch → event
 *   3. recalcInvoicePayments updates invoice_status → paid / partially_paid
 *   4. Best-effort Google Sheet payment column sync (no-op if no sheet row yet)
 */

import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { getInvoiceData, upsertInvoiceData } from "@/lib/invoice-data";
import {
  createPaymentBatch,
  createAllocation,
  getLatestPaymentMeta,
} from "@/lib/payment-batches";
import { updateSheetPaymentColumns } from "@/lib/google-sheets";
import { round2 } from "@/lib/invoice-calculations";

export const dynamic = "force-dynamic";

function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return parseFloat(v);
  return NaN;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { eventId: string } },
): Promise<NextResponse> {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const eventId = params.eventId;
  if (!eventId) return NextResponse.json({ error: "missing_event_id" }, { status: 400 });

  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }

  const amountPaid = round2(toNumber(body.amount_paid));
  const paidDate = body.paid_date;
  const paymentMethod =
    typeof body.payment_method === "string" && body.payment_method.trim()
      ? body.payment_method.trim()
      : "Direct Deposit";
  const reference =
    typeof body.reference === "string" && body.reference.trim()
      ? body.reference.trim()
      : null;

  if (!Number.isFinite(amountPaid) || amountPaid <= 0) {
    return NextResponse.json(
      { error: "validation_failed", detail: "amount_paid must be > 0" },
      { status: 400 },
    );
  }
  if (!isIsoDate(paidDate)) {
    return NextResponse.json(
      { error: "validation_failed", detail: "paid_date must be YYYY-MM-DD" },
      { status: 400 },
    );
  }

  // Load existing invoice row (may be null for historical jobs not yet in the app)
  let invoiceData = await getInvoiceData(eventId);

  // Resolve the invoice total we'll use for recalculation
  let invoiceTotal: number | null = invoiceData?.invoice_total ?? null;
  if (invoiceTotal == null) {
    const bodyTotal = round2(toNumber(body.invoice_total));
    if (!Number.isFinite(bodyTotal) || bodyTotal <= 0) {
      return NextResponse.json(
        {
          error: "invoice_total_required",
          detail:
            "This job has no stored invoice total. Pass invoice_total in the request body.",
        },
        { status: 400 },
      );
    }
    invoiceTotal = bodyTotal;
  }

  // Ensure invoice_data row exists and has invoice_total set (needed by recalcInvoicePayments)
  if (!invoiceData) {
    invoiceData = await upsertInvoiceData(eventId, { invoice_total: invoiceTotal });
  } else if (invoiceData.invoice_total == null) {
    invoiceData = await upsertInvoiceData(eventId, { invoice_total: invoiceTotal });
  }

  // Create a payment batch for this received payment
  const batch = await createPaymentBatch({
    client_name: "Light Action",
    received_date: paidDate,
    amount: amountPaid,
    payment_method: paymentMethod,
    reference,
    created_by: auth.editorId ?? null,
  });

  // Allocate to this invoice (calls recalcInvoicePayments internally)
  const { allocation, newAmountPaid, newRemainingBalance } = await createAllocation(
    {
      payment_batch_id: batch.id,
      google_event_id: eventId,
      allocated_amount: amountPaid,
    },
    invoiceTotal,
  );

  const isOverpayment = amountPaid > invoiceTotal + 0.005;

  // Best-effort: push payment status to Google Sheets.
  // No-op if the job's sheet row doesn't exist yet.
  try {
    const [fresh, paymentMeta] = await Promise.all([
      getInvoiceData(eventId),
      getLatestPaymentMeta(eventId),
    ]);
    if (fresh && (fresh.la_number || fresh.invoice_number)) {
      await updateSheetPaymentColumns({
        laJobNumber:         fresh.la_number ?? "",
        invoiceNumber:       fresh.invoice_number ?? "",
        status:              fresh.invoice_status,
        paidDate:            fresh.paid_date ?? "",
        invoicePdfUrl:       fresh.invoice_pdf_url ?? "",
        invoiceSentDate:     fresh.invoice_sent_at ? fresh.invoice_sent_at.slice(0, 10) : "",
        amountPaid:          fresh.amount_paid,
        remainingBalance:    fresh.remaining_balance ?? 0,
        paymentMethod:       paymentMeta.paymentMethod,
        paymentReceivedDate: paymentMeta.paymentReceivedDate,
        paymentBatchRef:     paymentMeta.paymentBatchRef,
      });
    }
  } catch (err) {
    console.error(
      `[record-payment] sheet sync failed (non-fatal): ${err instanceof Error ? err.message : err}`,
    );
  }

  return NextResponse.json(
    {
      ok: true,
      isOverpayment,
      batchId:        batch.id,
      allocationId:   allocation.id,
      newAmountPaid,
      newRemainingBalance,
    },
    { status: 201 },
  );
}
