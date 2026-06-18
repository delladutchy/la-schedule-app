/**
 * POST /api/invoice/email/[eventId]
 *
 * Jeff-only. Sends the invoice PDF — attached directly — via Resend.
 * NEVER auto-sends — requires explicit user action.
 *
 * Body (JSON):
 *   to         — string | string[]  (required; at least one address)
 *   cc         — string[]           (optional)
 *   subject    — string             (optional override)
 *   gigSummary — string             (optional job name for subject/body)
 *
 * Flow:
 *   1. Validate auth + addresses
 *   2. Load invoice data
 *   3. Fetch PDF from Supabase Storage (fails early if unavailable)
 *   4. Send email WITH PDF attached + backup link in body
 *   5. Mark invoice as sent (only on success)
 *
 * On send failure: does NOT update status.
 * On PDF fetch failure: returns explicit error, does NOT send.
 */

import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { getInvoiceData, markInvoiceSent } from "@/lib/invoice-data";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Address helpers
// ---------------------------------------------------------------------------

function normaliseTo(raw: unknown): string[] {
  if (typeof raw === "string") return raw.trim() ? [raw.trim()] : [];
  if (Array.isArray(raw)) return (raw as unknown[]).filter((v): v is string => typeof v === "string").map((s) => s.trim()).filter(Boolean);
  return [];
}

function normaliseCC(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).filter((v): v is string => typeof v === "string").map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Filename helpers
// ---------------------------------------------------------------------------

/**
 * Build a safe PDF attachment filename.
 * Format: Invoice-{invoiceNumber}-LA{laNumber}.pdf
 * Example: Invoice-1001-LA71760.pdf
 */
function buildAttachmentFilename(invoiceNumber: string, laNumber: string): string {
  // invoiceNumber is already clean (numeric format, e.g. "1001").
  // laNumber may contain spaces, #, slashes, etc. — strip to alnum+hyphen.
  const safeLa = laNumber.trim().replace(/[^a-zA-Z0-9\-]/g, "");
  const parts = ["Invoice", invoiceNumber || "invoice"];
  if (safeLa) parts.push(`LA${safeLa}`);
  return `${parts.join("-")}.pdf`;
}

// ---------------------------------------------------------------------------
// Date formatting helpers
// ---------------------------------------------------------------------------

function parseISODate(iso: string): Date | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function fmtDate(d: Date): string {
  return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function fmtDateShort(d: Date): string {
  return `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`;
}

/**
 * Format a list of YYYY-MM-DD dates as a human range.
 * Single date: "Jun 18, 2026"
 * Same month/year: "Jun 18–20, 2026"
 * Different months/years: "Jun 18 – Jul 2, 2026"
 */
function formatWorkDateRange(isoDates: string[]): string {
  const valid = isoDates
    .map(parseISODate)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());

  if (valid.length === 0) return "";
  if (valid.length === 1) return fmtDate(valid[0]!);

  const first = valid[0]!;
  const last  = valid[valid.length - 1]!;

  if (first.getFullYear() === last.getFullYear() && first.getMonth() === last.getMonth()) {
    return `${fmtDateShort(first)}–${last.getDate()}, ${first.getFullYear()}`;
  }
  return `${fmtDateShort(first)} – ${fmtDate(last)}`;
}

// ---------------------------------------------------------------------------
// Currency helper
// ---------------------------------------------------------------------------

function fmtCurrency(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
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

  // Parse body
  let rawBody: Record<string, unknown>;
  try {
    rawBody = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const toAddresses    = normaliseTo(rawBody.to);
  const ccAddresses    = normaliseCC(rawBody.cc);
  const gigSummary     = typeof rawBody.gigSummary === "string" ? rawBody.gigSummary.trim()  : "";
  const subjectOverride = typeof rawBody.subject   === "string" ? rawBody.subject.trim()     : "";

  // Server-side TODO_ guard — client already blocks these, but belt-and-suspenders.
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

  // Load invoice
  const invoiceData = await getInvoiceData(params.eventId);
  if (!invoiceData) return NextResponse.json({ error: "not_found" }, { status: 404 });

  if (!invoiceData.invoice_pdf_url) {
    return NextResponse.json(
      { error: "no_pdf", detail: "Generate the PDF first (POST /api/invoice/pdf/[eventId])" },
      { status: 400 },
    );
  }

  const invoiceNumber = invoiceData.invoice_number ?? "";
  const laNumber      = invoiceData.la_number ?? "";
  const invoiceTotal  = invoiceData.invoice_total;
  const workDates     = (invoiceData.workday_entries ?? []).map((e) => e.date);
  const dateRange     = formatWorkDateRange(workDates);

  // Step 1: Fetch the PDF from Supabase Storage.
  // Fail early with a clear error — don't send the email without the attachment.
  let pdfBuffer: Buffer;
  try {
    const pdfRes = await fetch(invoiceData.invoice_pdf_url);
    if (!pdfRes.ok) {
      console.error(`[invoice/email] PDF fetch failed: ${pdfRes.status} ${pdfRes.statusText}`);
      return NextResponse.json(
        { error: "pdf_fetch_failed", detail: `Could not retrieve PDF (HTTP ${pdfRes.status}). Try regenerating the PDF.` },
        { status: 502 },
      );
    }
    pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());
  } catch (fetchErr) {
    const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    console.error(`[invoice/email] PDF fetch threw: ${msg}`);
    return NextResponse.json(
      { error: "pdf_fetch_failed", detail: `Network error fetching PDF: ${msg}` },
      { status: 502 },
    );
  }

  // Step 2: Build email content
  const attachmentFilename = buildAttachmentFilename(invoiceNumber, laNumber);

  const subject = subjectOverride || buildSubject(invoiceNumber, laNumber, gigSummary);

  const emailParams: EmailParams = {
    invoiceNumber,
    laNumber,
    gigSummary,
    pdfUrl: invoiceData.invoice_pdf_url,
    invoiceTotal: invoiceTotal ?? null,
    dateRange,
    attachmentFilename,
  };

  // Step 3: Send via Resend with PDF attached
  const fromName  = env.INVOICE_FROM_NAME ?? "Jeff Ulsh";
  const fromEmail = env.NOTIFY_EMAIL_FROM?.trim() ?? "invoices@resend.dev";
  const from      = fromEmail.includes("<") ? fromEmail : `${fromName} <${fromEmail}>`;

  const resend = new Resend(env.RESEND_API_KEY);
  const sendPayload: Parameters<typeof resend.emails.send>[0] = {
    from,
    to:      toAddresses,
    subject,
    html:    buildEmailHtml(emailParams),
    text:    buildEmailText(emailParams),
    attachments: [
      {
        filename:    attachmentFilename,
        content:     pdfBuffer,
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

  // Step 4: Mark invoice sent — only after confirmed delivery.
  const sentAt = new Date().toISOString();
  await markInvoiceSent(params.eventId, sentAt);

  return NextResponse.json({ ok: true, to: toAddresses, cc: ccAddresses, sentAt, subject, attachmentFilename });
}

// ---------------------------------------------------------------------------
// Subject line
// ---------------------------------------------------------------------------

function buildSubject(invoiceNumber: string, laNumber: string, gigSummary: string): string {
  const parts = [`Invoice ${invoiceNumber}`];
  if (laNumber) parts.push(`LA Job ${laNumber}`);
  if (gigSummary) parts.push(gigSummary);
  return parts.join(" — ");
}

// ---------------------------------------------------------------------------
// Email templates
// ---------------------------------------------------------------------------

interface EmailParams {
  invoiceNumber: string;
  laNumber: string;
  gigSummary: string;
  pdfUrl: string;
  invoiceTotal: number | null;
  dateRange: string;
  attachmentFilename: string;
}

function buildEmailHtml(p: EmailParams): string {
  const jobRef  = [p.laNumber && `LA Job #: ${p.laNumber}`, p.gigSummary].filter(Boolean).join(" — ");
  const jobLine = jobRef ? ` for <strong>${p.gigSummary || `LA Job ${p.laNumber}`}</strong>` : "";

  const invoiceLine = `<tr><td style="padding:4px 0;color:#555">Invoice #</td><td style="padding:4px 0 4px 24px;font-weight:600">${p.invoiceNumber}</td></tr>`;
  const laLine     = p.laNumber
    ? `<tr><td style="padding:4px 0;color:#555">LA Job #</td><td style="padding:4px 0 4px 24px">${p.laNumber}</td></tr>`
    : "";
  const totalLine  = p.invoiceTotal != null
    ? `<tr><td style="padding:4px 0;color:#555">Total</td><td style="padding:4px 0 4px 24px;font-weight:600">${fmtCurrency(p.invoiceTotal)}</td></tr>`
    : "";
  const dateLine   = p.dateRange
    ? `<tr><td style="padding:4px 0;color:#555">Work dates</td><td style="padding:4px 0 4px 24px">${p.dateRange}</td></tr>`
    : "";
  const methodLine = `<tr><td style="padding:4px 0;color:#555">Payment method</td><td style="padding:4px 0 4px 24px">Direct deposit</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Invoice ${p.invoiceNumber}</title></head>
<body style="font-family:sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px">
  <p style="margin-top:0">Hi,</p>
  <p>Attached is my invoice${jobLine}.</p>
  <table style="border-collapse:collapse;margin:16px 0">
    <tbody>
      ${invoiceLine}
      ${laLine}
      ${totalLine}
      ${dateLine}
      ${methodLine}
    </tbody>
  </table>
  <p style="margin-top:20px">
    <a href="${p.pdfUrl}" style="display:inline-block;padding:10px 20px;background:#1a56a0;color:#fff;text-decoration:none;border-radius:4px;font-size:14px">
      View / Download ${p.attachmentFilename}
    </a>
  </p>
  <p style="margin-top:32px;margin-bottom:0">Thanks again,<br/>Jeff</p>
</body>
</html>`;
}

function buildEmailText(p: EmailParams): string {
  const jobDesc = p.gigSummary || (p.laNumber ? `LA Job ${p.laNumber}` : "");
  const lines: string[] = [
    "Hi,",
    "",
    `Attached is my invoice${jobDesc ? " for " + jobDesc : ""}.`,
    "",
    `Invoice #: ${p.invoiceNumber}`,
  ];
  if (p.laNumber)             lines.push(`LA Job #: ${p.laNumber}`);
  if (p.invoiceTotal != null) lines.push(`Total: ${fmtCurrency(p.invoiceTotal)}`);
  if (p.dateRange)            lines.push(`Work dates: ${p.dateRange}`);
  lines.push("Payment method: Direct deposit");
  lines.push("");
  lines.push(`View / Download: ${p.pdfUrl}`);
  lines.push("");
  lines.push("Thanks again,");
  lines.push("Jeff");
  return lines.join("\n");
}
