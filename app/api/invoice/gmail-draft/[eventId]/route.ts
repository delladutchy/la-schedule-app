/**
 * POST /api/invoice/gmail-draft/[eventId]
 *
 * Jeff-only. Renders the full invoice PDF packet (with receipt appendix),
 * uploads it to storage, then creates a Gmail draft from jeffulsh@gmail.com
 * for manual review and sending.
 *
 * Does NOT mark the invoice as sent — that happens when you send the draft
 * from Gmail.  Does update the stored PDF URL and sheet row (same as Send
 * Invoice), so the PDF link stays current.
 *
 * Required env vars:
 *   GOOGLE_CLIENT_ID          — same OAuth client used for Calendar
 *   GOOGLE_CLIENT_SECRET      — same OAuth client secret
 *   GOOGLE_GMAIL_REFRESH_TOKEN — separate refresh token with gmail.compose scope
 *
 * Returns:
 *   { ok, draftId, draftUrl, subject, attachmentFilename, ... }
 */

import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import {
  getAllInvoiceNumbers,
  getInvoiceData,
  markGmailDraftCreated,
  markInvoicePdfCreated,
  markSheetSynced,
  markSheetSyncError,
} from "@/lib/invoice-data";
import { calculateInvoicePacket, generateSheetRow } from "@/lib/invoice-calculations";
import { resolveInvoiceNumber } from "@/lib/invoice-number";
import { renderInvoicePDF } from "@/lib/invoice-pdf";
import { upsertSheetRow } from "@/lib/google-sheets";
import { getSupabaseServerClient } from "@/lib/supabase";
import { getReceiptPagesForPdf } from "@/lib/invoice-attachments";
import { createGmailDraft, GmailAuthError } from "@/lib/gmail-draft";

export const dynamic = "force-dynamic";

const PDF_BUCKET = "invoice-pdfs";
const PDF_TEMPLATE = "orange-2026";
const GMAIL_FROM = "Jeff Ulsh <jeffulsh@gmail.com>";
const DEFAULT_BCC_SELF = "jeffulsh@gmail.com";

// ---------------------------------------------------------------------------
// Address helpers (shared with email route)
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

function normaliseBCC(raw: unknown): string[] {
  return normaliseCC(raw);
}

function appendUniqueEmail(addresses: string[], address: string): string[] {
  const clean = address.trim();
  if (!clean) return addresses;
  const exists = addresses.some((addr) => addr.trim().toLowerCase() === clean.toLowerCase());
  return exists ? addresses : [...addresses, clean];
}

// ---------------------------------------------------------------------------
// Invoice label helpers
// ---------------------------------------------------------------------------

function cleanLaNumber(laNumber: string | null): string {
  return (laNumber ?? "").replace(/^LA\s*#?\s*/i, "").replace(/[^a-zA-Z0-9-]/g, "");
}

function cleanLaFromGigSummary(summary: string): string {
  const match = summary.trim().match(/^\s*LA\s*#?\s*(\d{3,})\s*/i);
  return match?.[1] ?? "";
}

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

function formatJobTitle(gigSummary: string, laNumber: string | null): string {
  let title = gigSummary.trim();
  const cleanLa = cleanLaNumber(laNumber);
  if (cleanLa) {
    title = title
      .replace(
        new RegExp(`^\\s*LA\\s*#?\\s*${cleanLa.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:[-–—:|]+\\s*)?`, "i"),
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

function buildSubject(cleanLa: string, jobTitle: string): string {
  if (cleanLa) return `Jeff Ulsh - Invoice LA #${cleanLa}`;
  return `Jeff Ulsh - Invoice${jobTitle ? ` ${jobTitle}` : ""}`;
}

function buildAttachmentFilename(cleanLa: string, jobTitle: string, invoiceNumber: string): string {
  const nameSlug = jobTitle
    ? "-" + jobTitle.replace(/[^a-zA-Z0-9]/g, " ").trim().replace(/\s+/g, "-").slice(0, 30).replace(/-+$/, "")
    : "";
  if (cleanLa) return `Invoice-LA${cleanLa}${nameSlug}.pdf`;
  const numSlug = invoiceNumber.replace(/[^a-zA-Z0-9]/g, "");
  return `Invoice-${numSlug}${nameSlug}.pdf`;
}

interface EmailParams {
  cleanLa: string;
  jobTitle: string;
  workDateStr: string;
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
// PDF storage helpers
// ---------------------------------------------------------------------------

async function ensureBucket(): Promise<void> {
  const supabase = getSupabaseServerClient();
  const { error } = await supabase.storage.createBucket(PDF_BUCKET, { public: true });
  if (error && !error.message.toLowerCase().includes("already exists")) {
    throw new Error(`[invoice/gmail-draft] bucket create failed: ${error.message}`);
  }
}

async function uploadPdf(path: string, buffer: Buffer): Promise<string> {
  const supabase = getSupabaseServerClient();
  const { error } = await supabase.storage
    .from(PDF_BUCKET)
    .upload(path, buffer, { contentType: "application/pdf", upsert: true });
  if (error) throw new Error(`[invoice/gmail-draft] upload failed: ${error.message}`);
  const { data: { publicUrl } } = supabase.storage.from(PDF_BUCKET).getPublicUrl(path);
  return publicUrl;
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

  if (!env.GOOGLE_GMAIL_REFRESH_TOKEN) {
    return NextResponse.json(
      { error: "gmail_not_configured", detail: "Set GOOGLE_GMAIL_REFRESH_TOKEN in env (needs gmail.compose scope)" },
      { status: 503 },
    );
  }

  let rawBody: Record<string, unknown>;
  try {
    rawBody = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const toAddresses = normaliseTo(rawBody.to);
  const ccAddresses = normaliseCC(rawBody.cc);
  const configuredBccSelf = env.INVOICE_EMAIL_BCC_SELF?.trim() || DEFAULT_BCC_SELF;
  const bccAddresses = appendUniqueEmail(normaliseBCC(rawBody.bcc), configuredBccSelf);
  const gigSummary = typeof rawBody.gigSummary === "string" ? rawBody.gigSummary.trim() : "";
  const overrideSubject = typeof rawBody.overrideSubject === "string" && rawBody.overrideSubject.trim()
    ? rawBody.overrideSubject.trim() : null;
  const overrideBody = typeof rawBody.overrideBody === "string" && rawBody.overrideBody.trim()
    ? rawBody.overrideBody.trim() : null;

  const allAddresses = [...toAddresses, ...ccAddresses, ...bccAddresses];
  if (allAddresses.some((a) => a.startsWith("TODO_"))) {
    return NextResponse.json(
      { error: "unconfigured_recipient", detail: "One or more recipient addresses are TODO placeholders." },
      { status: 400 },
    );
  }

  if (toAddresses.length === 0) {
    return NextResponse.json({ error: "recipient_required", detail: "Provide 'to' in request body" }, { status: 400 });
  }

  const invoiceData = await getInvoiceData(params.eventId);
  if (!invoiceData) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const packet = calculateInvoicePacket(invoiceData);
  const allNums = await getAllInvoiceNumbers();
  const invoiceNumber = resolveInvoiceNumber(invoiceData.invoice_number, allNums);
  const cleanLa = cleanLaNumber(invoiceData.la_number) || cleanLaFromGigSummary(gigSummary);
  const effectiveLaNumber = cleanLa ? `LA#${cleanLa}` : null;
  const autoJobTitle = formatJobTitle(gigSummary, effectiveLaNumber);
  const jobTitle = invoiceData.invoice_job_name_override?.trim() || autoJobTitle;
  const workDateStr = fmtWorkDateRange(packet.workdays);
  const issuedDate = new Date().toISOString().slice(0, 10);

  const laSlug = invoiceData.la_number ? `-LA${cleanLaNumber(invoiceData.la_number)}` : "";
  const ts = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  const storagePath = `${params.eventId}/Invoice-${invoiceNumber}${laSlug}-${ts}.pdf`;

  // Fetch receipt appendix pages (same as PDF route and email route).
  const receiptPages = await getReceiptPagesForPdf(params.eventId, effectiveLaNumber);
  console.log(`[invoice/gmail-draft] receipt appendix pages: ${receiptPages.length}`);

  // Render full PDF packet.
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await renderInvoicePDF({
      packet,
      invoiceNumber,
      gigSummary,
      issuedDate,
      receiptPages,
      overrides: {
        jobNameOverride:               invoiceData.invoice_job_name_override,
        dayRateDescriptionOverride:    invoiceData.invoice_day_rate_description_override,
        otDescriptionOverride:         invoiceData.invoice_ot_description_override,
        perDiemDescriptionOverride:    invoiceData.invoice_per_diem_description_override,
        bagFeesDescriptionOverride:    invoiceData.invoice_bag_fees_description_override,
        parkingDescriptionOverride:    invoiceData.invoice_parking_description_override,
        uberDescriptionOverride:       invoiceData.invoice_uber_description_override,
        tollsDescriptionOverride:      invoiceData.invoice_tolls_description_override,
        hotelDescriptionOverride:      invoiceData.invoice_hotel_description_override,
        otherDescriptionOverride:      invoiceData.invoice_other_description_override,
        noteOverride:                  invoiceData.invoice_note_override,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[invoice/gmail-draft] PDF render failed: ${msg}`);
    return NextResponse.json({ error: "pdf_render_failed", detail: msg }, { status: 500 });
  }

  // Upload PDF to storage (keeps the stored PDF URL current).
  let pdfUrl: string;
  try {
    await ensureBucket();
    pdfUrl = await uploadPdf(storagePath, pdfBuffer);
    console.log(`[invoice/gmail-draft] PDF uploaded publicUrl=${pdfUrl}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[invoice/gmail-draft] PDF upload failed: ${msg}`);
    return NextResponse.json({ error: "pdf_upload_failed", detail: msg }, { status: 500 });
  }

  // Update invoice_data with current PDF URL.
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
    console.error(`[invoice/gmail-draft] PDF metadata update failed: ${msg}`);
    return NextResponse.json({ error: "pdf_metadata_update_failed", detail: msg }, { status: 500 });
  }

  // Build email content.
  const attachmentFilename = buildAttachmentFilename(cleanLa, jobTitle, invoiceNumber);
  const emailParams: EmailParams = { cleanLa, jobTitle, workDateStr };
  const subject = overrideSubject ?? buildSubject(cleanLa, jobTitle);
  const htmlBody = overrideBody ? buildEmailHtmlFromOverride(overrideBody) : buildEmailHtml(emailParams);
  const textBody = overrideBody ?? buildEmailText(emailParams);

  // Create Gmail draft.
  let draftResult: Awaited<ReturnType<typeof createGmailDraft>>;
  try {
    draftResult = await createGmailDraft({
      clientId:           env.GOOGLE_CLIENT_ID,
      clientSecret:       env.GOOGLE_CLIENT_SECRET,
      gmailRefreshToken:  env.GOOGLE_GMAIL_REFRESH_TOKEN,
      from:               GMAIL_FROM,
      to:                 toAddresses,
      cc:                 ccAddresses,
      bcc:                bccAddresses,
      subject,
      textBody,
      htmlBody,
      attachments: [
        {
          filename:    attachmentFilename,
          content:     pdfBuffer,
          mimeType:    "application/pdf",
        },
      ],
    });
  } catch (err) {
    if (err instanceof GmailAuthError) {
      console.error("[invoice/gmail-draft] Gmail OAuth invalid_grant — refresh token expired or revoked");
      return NextResponse.json(
        { ok: false, code: "GMAIL_AUTH_INVALID_GRANT", message: err.message },
        { status: 401 },
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[invoice/gmail-draft] Gmail draft creation failed: ${msg}`);
    return NextResponse.json({ error: "gmail_draft_failed", detail: msg }, { status: 502 });
  }

  console.log(`[invoice/gmail-draft] draft created draftId=${draftResult.draftId} messageId=${draftResult.messageId}`);

  let draftedInvoiceData = updatedInvoiceData;
  try {
    draftedInvoiceData = await markGmailDraftCreated(params.eventId, new Date().toISOString());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[invoice/gmail-draft] draft status update failed (non-fatal): ${msg}`);
  }

  // Sync Sheet row after draft creation so status/PDF URL/balance reflect the final packet.
  try {
    const sheetPacket = calculateInvoicePacket(draftedInvoiceData);
    const sheetRow = generateSheetRow(sheetPacket, gigSummary, invoiceNumber, undefined, {
      sentTo:          draftedInvoiceData.invoice_sent_to,
      sentSubject:     draftedInvoiceData.invoice_sent_subject,
      jobNameOverride: draftedInvoiceData.invoice_job_name_override,
    });
    await upsertSheetRow(sheetRow);
    await markSheetSynced(params.eventId, new Date().toISOString());
  } catch (sheetErr) {
    const sheetMsg = sheetErr instanceof Error ? sheetErr.message : String(sheetErr);
    console.error(`[invoice/gmail-draft] sheet sync failed (non-fatal): ${sheetMsg}`);
    try { await markSheetSyncError(params.eventId, sheetMsg); } catch { /* ignore */ }
  }

  return NextResponse.json({
    ok: true,
    draftId:              draftResult.draftId,
    messageId:            draftResult.messageId,
    draftUrl:             draftResult.draftUrl,
    subject,
    attachmentFilename,
    to:                   toAddresses,
    cc:                   ccAddresses,
    bcc:                  bccAddresses,
    invoice_number:       draftedInvoiceData.invoice_number,
    invoice_status:       draftedInvoiceData.invoice_status,
    invoice_pdf_url:      draftedInvoiceData.invoice_pdf_url,
    invoice_pdf_path:     storagePath,
    invoice_total:        draftedInvoiceData.invoice_total,
    remaining_balance:    draftedInvoiceData.remaining_balance,
    template:             PDF_TEMPLATE,
    receiptAppendixPages: receiptPages.length,
    receiptAttachments:   0,
  });
}
