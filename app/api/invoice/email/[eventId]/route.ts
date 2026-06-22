/**
 * POST /api/invoice/email/[eventId]
 *
 * Jeff-only. Regenerates the invoice PDF from current invoice_data, attaches
 * that freshly rendered PDF, then marks the invoice sent after Resend succeeds.
 */

import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import {
  getAllInvoiceNumbers,
  getInvoiceData,
  markInvoicePdfCreated,
  markInvoiceSent,
  markSheetSynced,
  markSheetSyncError,
} from "@/lib/invoice-data";
import { calculateInvoicePacket, generateSheetRow } from "@/lib/invoice-calculations";
import { resolveInvoiceNumber } from "@/lib/invoice-number";
import { renderInvoicePDF } from "@/lib/invoice-pdf";
import { upsertSheetRow } from "@/lib/google-sheets";
import { getSupabaseServerClient } from "@/lib/supabase";
import { getEmailAttachments, getReceiptPagesForPdf } from "@/lib/invoice-attachments";

export const dynamic = "force-dynamic";

const PDF_BUCKET = "invoice-pdfs";
const PDF_TEMPLATE = "orange-2026";

// ---------------------------------------------------------------------------
// Address helpers
// ---------------------------------------------------------------------------

function normaliseTo(raw: unknown): string[] {
  if (typeof raw === "string") return raw.trim() ? [raw.trim()] : [];
  if (Array.isArray(raw)) {
    return raw
      .filter((v): v is string => typeof v === "string")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function normaliseCC(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((v): v is string => typeof v === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Invoice label helpers
// ---------------------------------------------------------------------------

function cleanLaNumber(laNumber: string | null): string {
  return (laNumber ?? "").replace(/^LA\s*#?\s*/i, "").replace(/[^a-zA-Z0-9-]/g, "");
}

// Parse LA digits out of a raw calendar event title as a fallback when la_number
// is not saved in invoice_data.  "LA#5555 — test job" → "5555"
function cleanLaFromGigSummary(summary: string): string {
  const match = summary.trim().match(/^\s*LA\s*#?\s*(\d{3,})\s*/i);
  return match?.[1] ?? "";
}

// Convert plain-text override body to a simple HTML email.
function buildEmailHtmlFromOverride(text: string): string {
  const paras = text
    .split(/\n{2,}/)
    .map((para) => {
      const escaped = para
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "<br>");
      return `<p style="margin:0 0 20px">${escaped}</p>`;
    })
    .join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:32px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:#111;background:#fff">
${paras}
</body>
</html>`;
}

function formatClientInvoiceNumber(laNumber: string | null, invoiceNumber: string): string {
  const cleanLa = cleanLaNumber(laNumber);
  return cleanLa ? `${invoiceNumber} - LA #${cleanLa}` : invoiceNumber;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatJobTitle(gigSummary: string, laNumber: string | null): string {
  let title = gigSummary.trim();
  const cleanLa = cleanLaNumber(laNumber);
  if (cleanLa) {
    title = title
      .replace(
        new RegExp(`^\\s*LA\\s*#?\\s*${escapeRegExp(cleanLa)}\\s*(?:[-–—:|]+\\s*)?`, "i"),
        "",
      )
      .trim();
  }
  return title.replace(/^[\s\-–—:|]+/, "").trim();
}

function fmtWorkDateRange(workdays: { date: string }[]): string {
  if (workdays.length === 0) return "";
  const dates = workdays.map((w) => w.date).sort();
  const fmtShort = (iso: string) => {
    const [, mo, d] = iso.split("-").map(Number);
    return `${mo}/${d}`;
  };
  if (dates.length === 1) return fmtShort(dates[0]!);
  return `${fmtShort(dates[0]!)} - ${fmtShort(dates[dates.length - 1]!)}`;
}

// Subject: LA-centric. No internal invoice number. Job name only when no LA number.
function buildSubject(cleanLa: string, jobTitle: string): string {
  if (cleanLa) return `Jeff Ulsh - Invoice LA #${cleanLa}`;
  return `Jeff Ulsh - Invoice${jobTitle ? ` ${jobTitle}` : ""}`;
}

// Attachment filename: client-facing. Invoice-LA71852-Wilm-U-Grad.pdf
function buildAttachmentFilename(cleanLa: string, jobTitle: string, invoiceNumber: string): string {
  const nameSlug = jobTitle
    ? "-" + jobTitle.replace(/[^a-zA-Z0-9]/g, " ").trim().replace(/\s+/g, "-").slice(0, 30).replace(/-+$/, "")
    : "";
  if (cleanLa) return `Invoice-LA${cleanLa}${nameSlug}.pdf`;
  const numSlug = invoiceNumber.replace(/[^a-zA-Z0-9]/g, "");
  return `Invoice-${numSlug}${nameSlug}.pdf`;
}

// ---------------------------------------------------------------------------
// PDF storage helpers
// ---------------------------------------------------------------------------

async function ensureBucket(): Promise<void> {
  const supabase = getSupabaseServerClient();
  const { error } = await supabase.storage.createBucket(PDF_BUCKET, { public: true });
  if (error && !error.message.toLowerCase().includes("already exists")) {
    throw new Error(`[invoice/email] bucket create failed: ${error.message}`);
  }
}

async function uploadPdf(path: string, buffer: Buffer): Promise<string> {
  const supabase = getSupabaseServerClient();
  const { error } = await supabase.storage
    .from(PDF_BUCKET)
    .upload(path, buffer, {
      contentType: "application/pdf",
      upsert: true,
    });

  if (error) throw new Error(`[invoice/email] upload failed: ${error.message}`);

  const { data: { publicUrl } } = supabase.storage
    .from(PDF_BUCKET)
    .getPublicUrl(path);

  return publicUrl;
}

// ---------------------------------------------------------------------------
// Email templates
// ---------------------------------------------------------------------------

interface EmailParams {
  cleanLa: string;     // "71852"
  jobTitle: string;    // "Wilm U Grad"
  workDateStr: string; // "5/31 - 6/1"
}

function buildInvoiceLine(p: EmailParams): string {
  let line = "Invoice for";
  if (p.cleanLa) line += ` LA#${p.cleanLa}`;
  if (p.jobTitle) line += ` ${p.jobTitle}`;
  if (p.workDateStr) line += ` - ${p.workDateStr}`;
  return line + ".";
}

function buildEmailHtml(p: EmailParams): string {
  const invoiceLine = buildInvoiceLine(p);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:32px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.65;color:#111;background:#fff">
<p style="margin:0 0 20px">${invoiceLine}</p>
<p style="margin:0 0 4px">Thank you guys,</p>
<p style="margin:0">Jeff Ulsh</p>
</body>
</html>`;
}

function buildEmailText(p: EmailParams): string {
  return [buildInvoiceLine(p), "", "Thank you guys,", "", "Jeff Ulsh"].join("\n");
}

// ---------------------------------------------------------------------------
// POST
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  { params }: { params: { eventId: string } },
): Promise<NextResponse> {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isJeffEditorId(auth.editorId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  if (!env.RESEND_API_KEY) {
    return NextResponse.json({ error: "resend_not_configured", detail: "Set RESEND_API_KEY in env" }, { status: 503 });
  }

  let rawBody: Record<string, unknown>;
  try {
    rawBody = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const toAddresses = normaliseTo(rawBody.to);
  const ccAddresses = normaliseCC(rawBody.cc);
  const gigSummary = typeof rawBody.gigSummary === "string" ? rawBody.gigSummary.trim() : "";
  const overrideSubject = typeof rawBody.overrideSubject === "string" && rawBody.overrideSubject.trim()
    ? rawBody.overrideSubject.trim() : null;
  const overrideBody = typeof rawBody.overrideBody === "string" && rawBody.overrideBody.trim()
    ? rawBody.overrideBody.trim() : null;

  const allAddresses = [...toAddresses, ...ccAddresses];
  if (allAddresses.some((a) => a.startsWith("TODO_"))) {
    return NextResponse.json(
      { error: "unconfigured_recipient", detail: "One or more recipient addresses are TODO placeholders and have not been configured yet." },
      { status: 400 },
    );
  }

  if (toAddresses.length === 0) {
    return NextResponse.json({ error: "recipient_required", detail: "Provide 'to' in request body" }, { status: 400 });
  }

  const invoiceData = await getInvoiceData(params.eventId);
  if (!invoiceData) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Pre-flight: check receipt attachments BEFORE expensive PDF render
  // Block send if any selected receipt is missing or inaccessible.
  let receiptAttachments: Array<{ buffer: Buffer; filename: string; mimeType: string; id: string }> = [];
  let missingAttachmentIds: string[] = [];
  try {
    const result = await getEmailAttachments(params.eventId);
    receiptAttachments = result.attachments;
    missingAttachmentIds = result.missingIds;
  } catch (err) {
    console.error(`[invoice/email] attachment fetch failed (non-fatal): ${err instanceof Error ? err.message : err}`);
  }

  if (missingAttachmentIds.length > 0) {
    return NextResponse.json(
      {
        error: "attachment_missing",
        detail: `${missingAttachmentIds.length} selected receipt${missingAttachmentIds.length > 1 ? "s are" : " is"} missing or inaccessible. Uncheck or remove them in Attachments / Receipts and try again.`,
        missingIds: missingAttachmentIds,
      },
      { status: 400 },
    );
  }

  const packet = calculateInvoicePacket(invoiceData);
  const allNums = await getAllInvoiceNumbers();
  const invoiceNumber = resolveInvoiceNumber(invoiceData.invoice_number, allNums);
  // Effective LA: stored la_number first; fall back to parsing from gigSummary title.
  const cleanLa = cleanLaNumber(invoiceData.la_number) || cleanLaFromGigSummary(gigSummary);
  const effectiveLaNumber = cleanLa ? `LA#${cleanLa}` : null;
  const clientInvoiceNumber = formatClientInvoiceNumber(effectiveLaNumber, invoiceNumber);
  const autoJobTitle = formatJobTitle(gigSummary, effectiveLaNumber);
  // If user set a job name override, use it in the email body instead of the auto-cleaned title.
  const jobTitle = invoiceData.invoice_job_name_override?.trim() || autoJobTitle;
  const workDateStr = fmtWorkDateRange(packet.workdays);
  const issuedDate = new Date().toISOString().slice(0, 10);

  const laSlug = invoiceData.la_number
    ? `-LA${cleanLaNumber(invoiceData.la_number)}`
    : "";
  const ts = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  const storagePath = `${params.eventId}/Invoice-${invoiceNumber}${laSlug}-${ts}.pdf`;

  const receiptPages = await getReceiptPagesForPdf(params.eventId, effectiveLaNumber);
  console.log(`[invoice/email] receipt appendix pages: ${receiptPages.length}`);
  console.log(`[invoice/email] regenerating PDF before send template=${PDF_TEMPLATE} invoiceNumber=${invoiceNumber} clientInvoiceNumber=${clientInvoiceNumber} storagePath=${storagePath}`);

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await renderInvoicePDF({
      packet,
      invoiceNumber,
      gigSummary,
      issuedDate,
      receiptPages,
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
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[invoice/email] PDF render failed: ${msg}`);
    return NextResponse.json({ error: "pdf_render_failed", detail: msg }, { status: 500 });
  }

  let pdfUrl: string;
  try {
    await ensureBucket();
    pdfUrl = await uploadPdf(storagePath, pdfBuffer);
    console.log(`[invoice/email] fresh PDF uploaded publicUrl=${pdfUrl}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[invoice/email] PDF upload failed: ${msg}`);
    return NextResponse.json({ error: "pdf_upload_failed", detail: msg }, { status: 500 });
  }

  const createdAt = new Date().toISOString();
  let updatedInvoiceData: Awaited<ReturnType<typeof markInvoicePdfCreated>>;
  try {
    updatedInvoiceData = await markInvoicePdfCreated(params.eventId, {
      invoiceNumber,
      pdfUrl,
      total: packet.estimatedTotal,
      createdAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[invoice/email] PDF metadata update failed: ${msg}`);
    return NextResponse.json({ error: "pdf_metadata_update_failed", detail: msg }, { status: 500 });
  }

  try {
    const sheetPacket = calculateInvoicePacket(updatedInvoiceData);
    const sheetRow = generateSheetRow(sheetPacket, gigSummary, invoiceNumber, undefined, {
      sentTo: updatedInvoiceData.invoice_sent_to,
      sentSubject: updatedInvoiceData.invoice_sent_subject,
      jobNameOverride: updatedInvoiceData.invoice_job_name_override,
    });
    await upsertSheetRow(sheetRow);
  } catch (sheetErr) {
    console.error(`[invoice/email] sheet sync failed after PDF regeneration (non-fatal): ${sheetErr instanceof Error ? sheetErr.message : sheetErr}`);
  }

  const attachmentFilename = buildAttachmentFilename(cleanLa, jobTitle, invoiceNumber);
  // Use client-provided subject/body overrides (the user may have edited them in the Review panel).
  // Fall back to server-generated defaults when not provided.
  const emailParams: EmailParams = { cleanLa, jobTitle, workDateStr };
  const subject = overrideSubject ?? buildSubject(cleanLa, jobTitle);
  const emailHtml = overrideBody ? buildEmailHtmlFromOverride(overrideBody) : buildEmailHtml(emailParams);
  const emailText = overrideBody ?? buildEmailText(emailParams);

  const fromName = env.INVOICE_FROM_NAME ?? "Jeff Ulsh";
  const fromEmail = env.NOTIFY_EMAIL_FROM?.trim() ?? "invoices@resend.dev";
  const from = fromEmail.includes("<") ? fromEmail : `${fromName} <${fromEmail}>`;

  const resend = new Resend(env.RESEND_API_KEY);
  const sendPayload: Parameters<typeof resend.emails.send>[0] = {
    from,
    to: toAddresses,
    subject,
    html: emailHtml,
    text: emailText,
    attachments: [
      {
        filename: attachmentFilename,
        content: pdfBuffer,
        contentType: "application/pdf",
      },
      ...receiptAttachments.map((a) => ({
        filename: a.filename,
        content: a.buffer,
        contentType: a.mimeType,
      })),
    ],
  };
  if (ccAddresses.length > 0) sendPayload.cc = ccAddresses;

  const { error: sendError } = await resend.emails.send(sendPayload);

  if (sendError) {
    console.error(`[invoice/email] send failed: ${JSON.stringify(sendError)}`);
    return NextResponse.json(
      { error: "send_failed", detail: String(sendError) },
      { status: 502 },
    );
  }

  const sentAt = new Date().toISOString();
  const sentTo = [...toAddresses, ...ccAddresses].join(", ");
  const sentSubject = subject;
  await markInvoiceSent(params.eventId, sentAt, sentTo, sentSubject);

  // Re-sync Google Sheet with invoice_status = "sent", sent date, sentTo, and sentSubject.
  // The earlier upsertSheetRow used status from packet (sheet_synced); this corrects it.
  try {
    const sentPacket = calculateInvoicePacket({
      ...updatedInvoiceData,
      invoice_status: "sent",
      invoice_sent_at: sentAt,
      invoice_sent_to: sentTo,
      invoice_sent_subject: sentSubject,
    });
    const sentSheetRow = generateSheetRow(sentPacket, gigSummary, invoiceNumber, undefined, {
      sentTo,
      sentSubject,
      jobNameOverride: updatedInvoiceData.invoice_job_name_override,
    });
    await upsertSheetRow(sentSheetRow);
    await markSheetSynced(params.eventId, new Date().toISOString());
  } catch (sheetErr) {
    const sheetMsg = sheetErr instanceof Error ? sheetErr.message : String(sheetErr);
    console.error(`[invoice/email] post-send sheet re-sync failed (non-fatal): ${sheetMsg}`);
    try { await markSheetSyncError(params.eventId, sheetMsg); } catch { /* ignore secondary failure */ }
  }

  return NextResponse.json({
    ok: true,
    to: toAddresses,
    cc: ccAddresses,
    sentAt,
    sentTo,
    sentSubject,
    subject,
    attachmentFilename,
    invoice_number: updatedInvoiceData.invoice_number,
    client_invoice_number: clientInvoiceNumber,
    invoice_pdf_url: updatedInvoiceData.invoice_pdf_url,
    invoice_pdf_path: storagePath,
    invoice_total: updatedInvoiceData.invoice_total,
    remaining_balance: updatedInvoiceData.remaining_balance,
    template: PDF_TEMPLATE,
    receiptAttachmentCount: receiptAttachments.length,
  });
}
