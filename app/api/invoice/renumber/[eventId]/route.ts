/**
 * POST /api/invoice/renumber/[eventId]
 *
 * Jeff-only. Assigns the next sequential numeric invoice number to an invoice
 * that currently has a non-numeric (legacy JU-date style) number.
 *
 * Safe to call multiple times:
 *   - If the invoice_number is already numeric, returns 200 { ok: true, alreadyNumeric: true }.
 *   - If the event has no invoice data, returns 404.
 *
 * This route ONLY updates invoice_data.invoice_number.
 * After calling this route the client is expected to call POST /api/invoice/pdf/[eventId]
 * to regenerate the PDF and sync Google Sheets with the new number.
 */

import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { getInvoiceData, getAllInvoiceNumbers, upsertInvoiceData } from "@/lib/invoice-data";
import { isNumericInvoiceNumber, resolveInvoiceNumber } from "@/lib/invoice-number";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: { eventId: string } },
): Promise<NextResponse> {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isJeffEditorId(auth.editorId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const invoiceData = await getInvoiceData(params.eventId);
  if (!invoiceData) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Already numeric — no-op (idempotent).
  if (isNumericInvoiceNumber(invoiceData.invoice_number)) {
    return NextResponse.json({
      ok: true,
      alreadyNumeric: true,
      newNumber: invoiceData.invoice_number,
    });
  }

  // Assign the next sequential number.
  // Pass null so resolveInvoiceNumber always allocates a fresh number
  // (passing the JU-style string would also work since it's non-numeric, but null is explicit).
  const allNums = await getAllInvoiceNumbers();
  const newNumber = resolveInvoiceNumber(null, allNums);

  await upsertInvoiceData(params.eventId, { invoice_number: newNumber });

  return NextResponse.json({
    ok: true,
    alreadyNumeric: false,
    newNumber,
    previousNumber: invoiceData.invoice_number,
  });
}
