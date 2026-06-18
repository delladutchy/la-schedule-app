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
import { getInvoiceData, getAllInvoiceNumbers, markInvoicePdfCreated } from "@/lib/invoice-data";
import { calculateInvoicePacket } from "@/lib/invoice-calculations";
import { resolveInvoiceNumber } from "@/lib/invoice-number";
import { renderInvoicePDF } from "@/lib/invoice-pdf";
import { upsertSheetRow } from "@/lib/google-sheets";
import { generateSheetRow } from "@/lib/invoice-calculations";
import { getSupabaseServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const PDF_BUCKET = "invoice-pdfs";

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

  return NextResponse.json({
    invoiceNumber:  invoiceData.invoice_number,
    pdfUrl:         invoiceData.invoice_pdf_url,
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

  const issuedDate = new Date().toISOString().slice(0, 10);

  // Unique storage path on every regeneration — prevents Supabase CDN from
  // serving a cached older PDF at the same URL.
  const laSlug = invoiceData.la_number
    ? `-LA${invoiceData.la_number.replace(/[^a-zA-Z0-9]/g, "")}`
    : "";
  const ts = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14); // YYYYMMDDHHmmss
  const storagePath = `${params.eventId}/Invoice-${invoiceNumber}${laSlug}-${ts}.pdf`;

  console.log(`[invoice/pdf] template=orange-2026 invoiceNumber=${invoiceNumber} storagePath=${storagePath} logoUrl=https://la-schedule-app.netlify.app/brand/jeff-ulsh-logo.png`);

  // 1. Render PDF
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await renderInvoicePDF({ packet, invoiceNumber, gigSummary, issuedDate });
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
  await markInvoicePdfCreated(params.eventId, {
    invoiceNumber,
    pdfUrl,
    total: packet.estimatedTotal,
    createdAt,
  });

  // 4. Sync Google Sheets (best-effort — don't fail the PDF if sheets is down)
  try {
    const sheetRow = generateSheetRow(packet, gigSummary, invoiceNumber);
    await upsertSheetRow(sheetRow);
  } catch (sheetErr) {
    console.error(`[invoice/pdf] sheet sync failed (non-fatal): ${sheetErr instanceof Error ? sheetErr.message : sheetErr}`);
  }

  return NextResponse.json({
    ok: true,
    invoiceNumber,
    pdfUrl,
    invoiceTotal: packet.estimatedTotal,
    createdAt,
  });
}
