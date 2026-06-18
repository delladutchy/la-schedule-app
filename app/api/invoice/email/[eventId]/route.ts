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

  const invoiceNumber    = invoiceData.invoice_number ?? "";
  const laNumber         = invoiceData.la_number ?? "";
  const invoiceTotal     = invoiceData.invoice_total;
  const remainingBalance = invoiceData.remaining_balance ?? invoiceTotal;
  const workDates        = (invoiceData.workday_entries ?? []).map((e) => e.date);
  const dateRange        = formatWorkDateRange(workDates);

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
    pdfUrl:            invoiceData.invoice_pdf_url,
    invoiceTotal:      invoiceTotal      ?? null,
    remainingBalance:  remainingBalance  ?? null,
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

// Brand colors — coordinated with the Jeff Ulsh orange used in the PDF.
const BRAND_ORANGE = "#E87722";
const BRAND_ORANGE_DARK = "#C05A10";

// Logo hosted via Netlify public directory. Used in email header.
// Falls back gracefully via alt text when email clients block images.
const LOGO_URL = "https://la-schedule-app.netlify.app/brand/jeff-ulsh-logo.png";

interface EmailParams {
  invoiceNumber:   string;
  laNumber:        string;
  gigSummary:      string;
  pdfUrl:          string;
  invoiceTotal:    number | null;
  remainingBalance: number | null;
  dateRange:        string;
  attachmentFilename: string;
}

function row(label: string, value: string, bold = false): string {
  const valStyle = bold
    ? `font-size:14px;font-weight:700;text-align:right;color:#111;padding:9px 0;border-bottom:1px solid #F3F4F6`
    : `font-size:13px;text-align:right;color:#374151;padding:9px 0;border-bottom:1px solid #F3F4F6`;
  return `<tr>
    <td style="font-size:13px;color:#6B7280;padding:9px 0;border-bottom:1px solid #F3F4F6">${label}</td>
    <td style="${valStyle}">${value}</td>
  </tr>`;
}

function buildEmailHtml(p: EmailParams): string {
  const balanceDue = p.remainingBalance ?? p.invoiceTotal;
  const jobLabel   = p.gigSummary || (p.laNumber ? `LA Job #${p.laNumber}` : "");

  // Balance Due callout — shown prominently above the detail table.
  const balanceCallout = balanceDue != null
    ? `<div style="background:#FFF7ED;border:1.5px solid ${BRAND_ORANGE};border-radius:6px;padding:20px 24px;margin:0 0 28px;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:11px;font-weight:600;letter-spacing:0.05em;color:${BRAND_ORANGE};text-transform:uppercase;margin-bottom:4px">Balance Due</div>
          <div style="font-size:34px;font-weight:800;color:#111;line-height:1">${fmtCurrency(balanceDue)}</div>
        </div>
      </div>`
    : "";

  // Detail rows
  const rows = [
    row("Invoice #",      `<strong>${p.invoiceNumber}</strong>`, false),
    p.laNumber ? row("LA Job #", p.laNumber) : "",
    jobLabel   ? row("Job",      jobLabel)   : "",
    p.dateRange ? row("Work Dates", p.dateRange) : "",
    p.invoiceTotal != null ? row("Invoice Total", fmtCurrency(p.invoiceTotal), true) : "",
    row("Payment Method", "Direct Deposit"),
  ].filter(Boolean).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Invoice #${p.invoiceNumber} from Jeff Ulsh</title>
</head>
<body style="margin:0;padding:0;background:#F9FAFB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F9FAFB;padding:32px 16px">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:580px">

      <!-- Header bar -->
      <tr><td style="background:${BRAND_ORANGE};border-radius:8px 8px 0 0;padding:20px 32px">
        <table cellpadding="0" cellspacing="0"><tr>
          <td style="vertical-align:middle;padding-right:14px">
            <img src="${LOGO_URL}"
                 alt="Jeff Ulsh"
                 style="display:block;max-width:140px;width:140px;height:auto">
          </td>
          <td style="vertical-align:middle">
            <div style="color:#fff;font-size:20px;font-weight:800;letter-spacing:-0.3px;margin-bottom:2px">Jeff Ulsh</div>
            <div style="color:rgba(255,255,255,0.85);font-size:12px">Freelance Audio Engineer &middot; Dewey Beach, DE</div>
          </td>
        </tr></table>
      </td></tr>

      <!-- Body -->
      <tr><td style="background:#fff;padding:36px 32px 28px;border-left:1px solid #E5E7EB;border-right:1px solid #E5E7EB">

        <!-- Headline -->
        <p style="margin:0 0 6px;font-size:24px;font-weight:700;color:#111">Invoice Ready</p>
        <p style="margin:0 0 28px;font-size:14px;color:#6B7280">
          Invoice <strong style="color:#111">#${p.invoiceNumber}</strong> from Jeff Ulsh for Light Action${jobLabel ? ` &mdash; <strong style="color:#111">${jobLabel}</strong>` : ""}
        </p>

        <!-- Balance Due callout -->
        ${balanceCallout}

        <!-- Detail table -->
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px">
          <tbody>
            ${rows}
          </tbody>
        </table>

        <!-- CTA button -->
        <table cellpadding="0" cellspacing="0" style="margin-bottom:32px">
          <tr><td>
            <a href="${p.pdfUrl}"
               style="display:inline-block;background:${BRAND_ORANGE};color:#fff;font-size:14px;font-weight:600;text-decoration:none;padding:13px 28px;border-radius:5px;letter-spacing:0.01em">
              View / Download Invoice
            </a>
          </td></tr>
        </table>

        <!-- Note -->
        <p style="margin:0;font-size:13px;color:#9CA3AF">
          The invoice PDF is attached directly to this email. The button above links to the same file in Supabase Storage as a backup.
        </p>

      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#F9FAFB;border:1px solid #E5E7EB;border-top:none;border-radius:0 0 8px 8px;padding:20px 32px">
        <p style="margin:0;font-size:13px;color:#374151">Thanks again,<br><strong>Jeff</strong></p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function buildEmailText(p: EmailParams): string {
  const balanceDue = p.remainingBalance ?? p.invoiceTotal;
  const jobDesc    = p.gigSummary || (p.laNumber ? `LA Job #${p.laNumber}` : "");
  const lines: string[] = [
    `Invoice #${p.invoiceNumber} from Jeff Ulsh`,
    "─".repeat(40),
    "",
  ];
  if (balanceDue != null) {
    lines.push(`Balance Due: ${fmtCurrency(balanceDue)}`);
    lines.push("");
  }
  lines.push(`Invoice #: ${p.invoiceNumber}`);
  if (p.laNumber)        lines.push(`LA Job #: ${p.laNumber}`);
  if (jobDesc)           lines.push(`Job: ${jobDesc}`);
  if (p.dateRange)       lines.push(`Work Dates: ${p.dateRange}`);
  if (p.invoiceTotal != null) lines.push(`Invoice Total: ${fmtCurrency(p.invoiceTotal)}`);
  lines.push("Payment Method: Direct Deposit");
  lines.push("");
  lines.push(`View / Download Invoice: ${p.pdfUrl}`);
  lines.push("(PDF also attached directly to this email)");
  lines.push("");
  lines.push("Thanks again,");
  lines.push("Jeff Ulsh");
  return lines.join("\n");
}
