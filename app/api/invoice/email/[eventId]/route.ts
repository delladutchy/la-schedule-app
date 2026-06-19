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
} from "@/lib/invoice-data";
import { calculateInvoicePacket, generateSheetRow } from "@/lib/invoice-calculations";
import { resolveInvoiceNumber } from "@/lib/invoice-number";
import { renderInvoicePDF } from "@/lib/invoice-pdf";
import { upsertSheetRow } from "@/lib/google-sheets";
import { getSupabaseServerClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const PDF_BUCKET = "invoice-pdfs";
const PDF_TEMPLATE = "orange-2026";
const LOGO_URL = "https://la-schedule-app.netlify.app/brand/jeff-ulsh-logo.png";

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

function formatClientInvoiceNumber(laNumber: string | null, fallbackInvoiceNumber: string): string {
  const cleanLa = cleanLaNumber(laNumber);
  return cleanLa ? `LA #${cleanLa}` : fallbackInvoiceNumber;
}

function buildAttachmentFilename(clientInvoiceNumber: string): string {
  const safeNumber = clientInvoiceNumber.replace(/[^a-zA-Z0-9-]/g, "");
  return `Invoice-${safeNumber || "invoice"}.pdf`;
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

function buildSubject(clientInvoiceNumber: string, jobTitle: string): string {
  return ["Jeff Ulsh", `Invoice ${clientInvoiceNumber}`, jobTitle].filter(Boolean).join(" - ");
}

function fmtCurrency(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
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
  clientInvoiceNumber: string;
  jobTitle: string;
  balanceDue: number;
}

function invoiceSentence(p: EmailParams): string {
  return `Invoice ${p.clientInvoiceNumber}${p.jobTitle ? ` for ${p.jobTitle}` : ""} is attached.`;
}

function buildEmailHtml(p: EmailParams): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${invoiceSentence(p)}</title>
</head>
<body style="margin:0;padding:0;background:#F6F7F8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#222">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F6F7F8;padding:28px 14px">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #E5E7EB;border-radius:8px">
          <tr>
            <td style="padding:24px 28px 22px">
              <img src="${LOGO_URL}" alt="Jeff Ulsh" style="display:block;width:64px;max-width:64px;height:auto;margin:0 0 18px">
              <p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#333">Hi,</p>
              <p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:#333">${invoiceSentence(p)}</p>
              <p style="margin:0 0 22px;font-size:15px;line-height:1.5;color:#333"><strong>Balance due:</strong> ${fmtCurrency(p.balanceDue)}</p>
              <p style="margin:0;font-size:15px;line-height:1.5;color:#333">Thanks again,<br>Jeff</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildEmailText(p: EmailParams): string {
  return [
    "Hi,",
    "",
    invoiceSentence(p),
    "",
    `Balance due: ${fmtCurrency(p.balanceDue)}`,
    "",
    "Thanks again,",
    "Jeff",
  ].join("\n");
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

  const packet = calculateInvoicePacket(invoiceData);
  const allNums = await getAllInvoiceNumbers();
  const invoiceNumber = resolveInvoiceNumber(invoiceData.invoice_number, allNums);
  const clientInvoiceNumber = formatClientInvoiceNumber(invoiceData.la_number, invoiceNumber);
  const jobTitle = formatJobTitle(gigSummary, invoiceData.la_number);
  const issuedDate = new Date().toISOString().slice(0, 10);

  const laSlug = invoiceData.la_number
    ? `-LA${cleanLaNumber(invoiceData.la_number)}`
    : "";
  const ts = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  const storagePath = `${params.eventId}/Invoice-${invoiceNumber}${laSlug}-${ts}.pdf`;

  console.log(`[invoice/email] regenerating PDF before send template=${PDF_TEMPLATE} invoiceNumber=${invoiceNumber} clientInvoiceNumber=${clientInvoiceNumber} storagePath=${storagePath}`);

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await renderInvoicePDF({ packet, invoiceNumber, gigSummary, issuedDate });
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
    const sheetRow = generateSheetRow(packet, gigSummary, invoiceNumber);
    await upsertSheetRow(sheetRow);
  } catch (sheetErr) {
    console.error(`[invoice/email] sheet sync failed after PDF regeneration (non-fatal): ${sheetErr instanceof Error ? sheetErr.message : sheetErr}`);
  }

  const balanceDue = updatedInvoiceData.remaining_balance ?? packet.estimatedTotal;
  const attachmentFilename = buildAttachmentFilename(clientInvoiceNumber);
  const subject = buildSubject(clientInvoiceNumber, jobTitle);
  const emailParams: EmailParams = {
    clientInvoiceNumber,
    jobTitle,
    balanceDue,
  };

  const fromName = env.INVOICE_FROM_NAME ?? "Jeff Ulsh";
  const fromEmail = env.NOTIFY_EMAIL_FROM?.trim() ?? "invoices@resend.dev";
  const from = fromEmail.includes("<") ? fromEmail : `${fromName} <${fromEmail}>`;

  const resend = new Resend(env.RESEND_API_KEY);
  const sendPayload: Parameters<typeof resend.emails.send>[0] = {
    from,
    to: toAddresses,
    subject,
    html: buildEmailHtml(emailParams),
    text: buildEmailText(emailParams),
    attachments: [
      {
        filename: attachmentFilename,
        content: pdfBuffer,
        contentType: "application/pdf",
      },
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
  await markInvoiceSent(params.eventId, sentAt);

  return NextResponse.json({
    ok: true,
    to: toAddresses,
    cc: ccAddresses,
    sentAt,
    subject,
    attachmentFilename,
    invoice_number: updatedInvoiceData.invoice_number,
    client_invoice_number: clientInvoiceNumber,
    invoice_pdf_url: updatedInvoiceData.invoice_pdf_url,
    invoice_pdf_path: storagePath,
    invoice_total: updatedInvoiceData.invoice_total,
    remaining_balance: updatedInvoiceData.remaining_balance,
    template: PDF_TEMPLATE,
  });
}
