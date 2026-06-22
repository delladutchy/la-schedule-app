/**
 * POST /api/invoice/pdf/[eventId]
 *
 * Jeff-only. Generates a native invoice PDF, uploads it to Supabase Storage,
 * syncs Google Sheets, and updates invoice_data with the PDF URL and number.
 *
 * Body (JSON, all optional):
 *   gigSummary  — override job name shown in the PDF
 *
 * GET /api/invoice/pdf/[eventId]
 *   Returns the stored invoice metadata (number, pdfUrl, status) without
 *   regenerating. Use this to check whether a PDF already exists.
 */

import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { getInvoiceData, getAllInvoiceNumbers, markInvoicePdfCreated, markSheetSynced, markSheetSyncError } from "@/lib/invoice-data";
import { calculateInvoicePacket } from "@/lib/invoice-calculations";
import { resolveInvoiceNumber } from "@/lib/invoice-number";
import { renderInvoicePDF } from "@/lib/invoice-pdf";
import { upsertSheetRow } from "@/lib/google-sheets";
import { generateSheetRow } from "@/lib/invoice-calculations";
import { getSupabaseServerClient } from "@/lib/supabase";
import { getReceiptPagesForPdf } from "@/lib/invoice-attachments";

export const dynamic = "force-dynamic";

const PDF_BUCKET = "invoice-pdfs";
const PDF_TEMPLATE = "orange-2026";

async function ensureBucket(): Promise<void> {
  const supabase = getSupabaseServerClient();
  const { error } = await supabase.storage.createBucket(PDF_BUCKET, { public: true });
  // "already exists" is fine
  if (error && !error.message.toLowerCase().includes("already exists")) {
    throw new Error(`[invoice/pdf] bucket create failed: ${error.message}`);
  }
}

async function uploadPdf(
  path: string,
  buffer: Buffer,
): Promise<string> {
  const supabase = getSupabaseServerClient();
  const { error } = await supabase.storage
    .from(PDF_BUCKET)
    .upload(path, buffer, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (error) throw new Error(`[invoice/pdf] upload failed: ${error.message}`);

  const { data: { publicUrl } } = supabase.storage
    .from(PDF_BUCKET)
    .getPublicUrl(path);

  return publicUrl;
}

function storagePathFromPublicUrl(publicUrl: string | null): string | null {
  if (!publicUrl) return null;
  try {
    const url = new URL(publicUrl);
    const marker = `/storage/v1/object/public/${PDF_BUCKET}/`;
    const markerIndex = url.pathname.indexOf(marker);
    if (markerIndex === -1) return null;
    return decodeURIComponent(url.pathname.slice(markerIndex + marker.length));
  } catch {
    return null;
  }
}

function cleanLaNumber(laNumber: string | null): string {
  return (laNumber ?? "").replace(/^LA\s*#?\s*/i, "").replace(/[^a-zA-Z0-9-]/g, "");
}

function cleanLaFromGigSummary(summary: string): string {
  const match = summary.trim().match(/^\s*LA\s*#?\s*(\d{3,})\s*/i);
  return match?.[1] ?? "";
}

// ── GET ──────────────────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: { eventId: string } },
): Promise<NextResponse> {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isJeffEditorId(auth.editorId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const invoiceData = await getInvoiceData(params.eventId);
  if (!invoiceData) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const storagePath = storagePathFromPublicUrl(invoiceData.invoice_pdf_url);

  return NextResponse.json({
    invoice_number:  invoiceData.invoice_number,
    invoice_pdf_url: invoiceData.invoice_pdf_url,
    invoice_pdf_path: storagePath,
    invoice_updated_at: invoiceData.updated_at,
    invoice_created_at: invoiceData.invoice_created_at,
    invoice_total: invoiceData.invoice_total,
    timestamp: invoiceData.updated_at,
    template: PDF_TEMPLATE,
    invoiceNumber:  invoiceData.invoice_number,
    pdfUrl:         invoiceData.invoice_pdf_url,
    storagePath,
    invoiceStatus:  invoiceData.invoice_status,
    invoiceTotal:   invoiceData.invoice_total,
    invoiceCreatedAt: invoiceData.invoice_created_at,
    invoiceSentAt:  invoiceData.invoice_sent_at,
    amountPaid:     invoiceData.amount_paid,
    remainingBalance: invoiceData.remaining_balance,
  });
}

// ── POST ─────────────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: { eventId: string } },
): Promise<NextResponse> {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isJeffEditorId(auth.editorId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let gigSummary = "";
  try {
    const body = await request.json() as { gigSummary?: string };
    gigSummary = body.gigSummary?.trim() ?? "";
  } catch { /* body is optional */ }

  const invoiceData = await getInvoiceData(params.eventId);
  if (!invoiceData) return NextResponse.json({ error: "invoice_data_not_found" }, { status: 404 });

  const packet  = calculateInvoicePacket(invoiceData);
  const allNums = await getAllInvoiceNumbers();
  const invoiceNumber = resolveInvoiceNumber(invoiceData.invoice_number, allNums);
  console.log(`[invoice/pdf] regenerate start template=${PDF_TEMPLATE} invoiceNumber=${invoiceNumber} oldInvoicePdfUrl=${invoiceData.invoice_pdf_url ?? "null"}`);

  const issuedDate = new Date().toISOString().slice(0, 10);

  // Unique storage path on every regeneration — prevents Supabase CDN from
  // serving a cached older PDF at the same URL.
  const laSlug = invoiceData.la_number
    ? `-LA${invoiceData.la_number.replace(/[^a-zA-Z0-9]/g, "")}`
    : "";
  const ts = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14); // YYYYMMDDHHmmss
  const storagePath = `${params.eventId}/Invoice-${invoiceNumber}${laSlug}-${ts}.pdf`;

  console.log(`[invoice/pdf] template=${PDF_TEMPLATE} invoiceNumber=${invoiceNumber} storagePath=${storagePath} logoUrl=https://la-schedule-app.netlify.app/brand/jeff-ulsh-logo.png`);

  // Fetch receipt pages for the PDF appendix (non-fatal: empty array on any error).
  const cleanLa = cleanLaNumber(invoiceData.la_number) || cleanLaFromGigSummary(gigSummary);
  const effectiveLaNumber = cleanLa ? `LA#${cleanLa}` : null;
  const receiptPages = await getReceiptPagesForPdf(params.eventId, effectiveLaNumber);
  console.log(`[invoice/pdf] receipt appendix pages: ${receiptPages.length}`);

  // 1. Render PDF
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await renderInvoicePDF({
      packet,
      invoiceNumber,
      gigSummary,
      issuedDate,
      overrides: {
        jobNameOverride: invoiceData.invoice_job_name_override,
        dayRateDescriptionOverride: invoiceData.invoice_day_rate_description_override,
        otDescriptionOverride: invoiceData.invoice_ot_description_override,
        perDiemDescriptionOverride: invoiceData.invoice_per_diem_description_override,
        bagFeesDescriptionOverride: invoiceData.invoice_bag_fees_description_override,
        parkingDescriptionOverride: invoiceData.invoice_parking_description_override,
        uberDescriptionOverride: invoiceData.invoice_uber_description_override,
        tollsDescriptionOverride: invoiceData.invoice_tolls_description_override,
        hotelDescriptionOverride: invoiceData.invoice_hotel_description_override,
        otherDescriptionOverride: invoiceData.invoice_other_description_override,
        noteOverride: invoiceData.invoice_note_override,
      },
      receiptPages,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[invoice/pdf] render failed: ${msg}`);
    return NextResponse.json({ error: "pdf_render_failed", detail: msg }, { status: 500 });
  }

  // 2. Upload to Supabase Storage
  await ensureBucket();
  let pdfUrl: string;
  try {
    pdfUrl = await uploadPdf(storagePath, pdfBuffer);
    console.log(`[invoice/pdf] upload ok publicUrl=${pdfUrl}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[invoice/pdf] upload failed: ${msg}`);
    return NextResponse.json({ error: "pdf_upload_failed", detail: msg }, { status: 500 });
  }

  // 3. Persist invoice metadata
  const createdAt = new Date().toISOString();
  let updatedInvoiceData: Awaited<ReturnType<typeof markInvoicePdfCreated>>;
  try {
    updatedInvoiceData = await markInvoicePdfCreated(params.eventId, {
      invoiceNumber,
      pdfUrl,
      total: packet.estimatedTotal,
      createdAt,
    });
    console.log(`[invoice/pdf] metadata updated newInvoicePdfUrl=${updatedInvoiceData.invoice_pdf_url} invoiceUpdatedAt=${updatedInvoiceData.updated_at}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[invoice/pdf] metadata update failed: ${msg}`);
    return NextResponse.json(
      { error: "pdf_metadata_update_failed", detail: msg, invoice_pdf_url: pdfUrl, invoice_pdf_path: storagePath, storagePath },
      { status: 500 },
    );
  }

  // 4. Sync Google Sheets (best-effort — don't fail the PDF if sheets is down)
  try {
    const sheetRow = generateSheetRow(packet, gigSummary, invoiceNumber, undefined, {
      sentTo: invoiceData.invoice_sent_to,
      sentSubject: invoiceData.invoice_sent_subject,
      jobNameOverride: invoiceData.invoice_job_name_override,
    });
    await upsertSheetRow(sheetRow);
    await markSheetSynced(params.eventId, new Date().toISOString());
  } catch (sheetErr) {
    const sheetMsg = sheetErr instanceof Error ? sheetErr.message : String(sheetErr);
    console.error(`[invoice/pdf] sheet sync failed (non-fatal): ${sheetMsg}`);
    try { await markSheetSyncError(params.eventId, sheetMsg); } catch { /* ignore secondary failure */ }
  }

  return NextResponse.json({
    ok: true,
    invoice_number: updatedInvoiceData.invoice_number,
    invoice_pdf_url: updatedInvoiceData.invoice_pdf_url,
    invoice_pdf_path: storagePath,
    invoice_updated_at: updatedInvoiceData.updated_at,
    invoice_created_at: updatedInvoiceData.invoice_created_at,
    invoice_total: updatedInvoiceData.invoice_total,
    timestamp: updatedInvoiceData.updated_at,
    template: PDF_TEMPLATE,
    invoiceNumber,
    pdfUrl,
    storagePath,
    invoiceTotal: packet.estimatedTotal,
    createdAt,
  });
}
