/**
 * POST /api/invoice/mark-sent/[eventId]
 *
 * Jeff-only. Explicit user confirmation that an invoice was actually sent.
 *
 * The Gmail-draft flow (/api/invoice/gmail-draft/[eventId]) can only create a
 * draft — the send itself happens inside Gmail, which the app never observes.
 * This route is the only way that flow reaches invoice_status = "sent", and it
 * is never called automatically: the user must confirm "Mark as Sent" in the
 * invoice panel.
 *
 * Body (JSON, all optional):
 *   to        — string[] recipients used for the send
 *   cc        — string[] cc recipients used for the send
 *   subject   — subject line used for the send
 *   gigSummary — calendar event title, for the Google Sheet gigEvent column
 *
 * Recipients are never invented. When the caller supplies none, the stored
 * invoice_sent_to / invoice_sent_subject values are reused; when there are
 * none of those either, the columns are left untouched (markInvoiceSent only
 * writes them when non-null).
 */

import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import {
  getInvoiceData,
  markInvoiceSent,
  markSheetSynced,
  markSheetSyncError,
} from "@/lib/invoice-data";
import { calculateInvoicePacket, generateSheetRow } from "@/lib/invoice-calculations";
import { upsertSheetRow } from "@/lib/google-sheets";
import type { InvoiceStatus } from "@/lib/invoice-types";

export const dynamic = "force-dynamic";

/**
 * Statuses markInvoiceSent() will actually transition (see lib/invoice-data.ts).
 * Checked up front so a no-op UPDATE is reported as an error instead of "ok".
 */
const MARK_SENT_ALLOWED_STATUSES: readonly InvoiceStatus[] = ["sheet_synced", "draft_created", "sent"];

function normaliseAddressList(raw: unknown): string[] {
  if (typeof raw === "string") return raw.trim() ? [raw.trim()] : [];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function POST(
  request: NextRequest,
  { params }: { params: { eventId: string } },
): Promise<NextResponse> {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isJeffEditorId(auth.editorId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let rawBody: Record<string, unknown> = {};
  try {
    rawBody = await request.json() as Record<string, unknown>;
  } catch { /* body is optional */ }

  const toAddresses = normaliseAddressList(rawBody.to);
  const ccAddresses = normaliseAddressList(rawBody.cc);
  const gigSummary = typeof rawBody.gigSummary === "string" ? rawBody.gigSummary.trim() : "";
  const requestedSubject = typeof rawBody.subject === "string" && rawBody.subject.trim()
    ? rawBody.subject.trim()
    : null;

  const invoiceData = await getInvoiceData(params.eventId);
  if (!invoiceData) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (!invoiceData.invoice_number || !invoiceData.invoice_pdf_url) {
    return NextResponse.json(
      {
        error: "invoice_not_created",
        detail: "Create the invoice PDF before marking it sent.",
      },
      { status: 409 },
    );
  }

  if (!MARK_SENT_ALLOWED_STATUSES.includes(invoiceData.invoice_status)) {
    return NextResponse.json(
      {
        error: "invalid_status",
        detail: `Invoice status "${invoiceData.invoice_status}" cannot be marked sent.`,
        invoice_status: invoiceData.invoice_status,
      },
      { status: 409 },
    );
  }

  // Never fabricate recipients: fall back to what was already stored, else null.
  const combinedRecipients = [...toAddresses, ...ccAddresses].join(", ");
  const sentTo = combinedRecipients || invoiceData.invoice_sent_to || null;
  const sentSubject = requestedSubject ?? invoiceData.invoice_sent_subject ?? null;
  const sentAt = new Date().toISOString();

  try {
    await markInvoiceSent(params.eventId, sentAt, sentTo, sentSubject);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[invoice/mark-sent] status update failed: ${msg}`);
    return NextResponse.json({ error: "mark_sent_failed", detail: msg }, { status: 500 });
  }

  // Re-read so the client gets the persisted truth, and so a silently skipped
  // UPDATE (status guard inside markInvoiceSent) is caught rather than reported ok.
  const sentInvoiceData = await getInvoiceData(params.eventId);
  if (!sentInvoiceData || sentInvoiceData.invoice_status !== "sent") {
    console.error(`[invoice/mark-sent] status did not persist status=${sentInvoiceData?.invoice_status ?? "missing"}`);
    return NextResponse.json(
      { error: "mark_sent_not_applied", detail: "Invoice status was not updated — reload and try again." },
      { status: 500 },
    );
  }

  console.log(`[invoice/mark-sent] invoice=${sentInvoiceData.invoice_number} marked sent at ${sentAt}`);

  // Mirror the post-send Sheet sync used by /api/invoice/email so the Sheet's
  // STATUS / SENT DATE / SENT TO columns match Supabase. Non-fatal.
  try {
    const sentPacket = calculateInvoicePacket(sentInvoiceData);
    const sentSheetRow = generateSheetRow(sentPacket, gigSummary, sentInvoiceData.invoice_number ?? undefined, undefined, {
      sentTo: sentInvoiceData.invoice_sent_to,
      sentSubject: sentInvoiceData.invoice_sent_subject,
      jobNameOverride: sentInvoiceData.invoice_job_name_override,
    });
    await upsertSheetRow(sentSheetRow);
    await markSheetSynced(params.eventId, new Date().toISOString());
  } catch (sheetErr) {
    const sheetMsg = sheetErr instanceof Error ? sheetErr.message : String(sheetErr);
    console.error(`[invoice/mark-sent] sheet sync failed (non-fatal): ${sheetMsg}`);
    try { await markSheetSyncError(params.eventId, sheetMsg); } catch { /* ignore secondary failure */ }
  }

  // Re-read once more: markSheetSynced/markSheetSyncError touch the same row.
  const finalInvoiceData = await getInvoiceData(params.eventId) ?? sentInvoiceData;

  return NextResponse.json({
    ok: true,
    sentAt,
    sentTo,
    sentSubject,
    invoiceData: finalInvoiceData,
    packet: calculateInvoicePacket(finalInvoiceData),
  });
}
