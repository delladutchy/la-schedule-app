/**
 * POST /api/invoice/email/[eventId]
 *
 * Jeff-only. Sends the invoice PDF to the client via Resend.
 * NEVER auto-sends — requires explicit user action.
 *
 * Body (JSON):
 *   to         — recipient email (required)
 *   subject    — override subject line (optional)
 *   note       — override body note (optional)
 *   gigSummary — job name for subject/body (optional)
 *
 * Prerequisites: invoice PDF must already exist (POST /api/invoice/pdf first).
 *
 * On success: marks invoice_status = "sent" and invoice_sent_at = now.
 * On send failure: does NOT update status.
 */

import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { getInvoiceData, markInvoiceSent } from "@/lib/invoice-data";

export const dynamic = "force-dynamic";

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

  let body: { to?: string; subject?: string; note?: string; gigSummary?: string };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const to = body.to?.trim() ?? env.INVOICE_CLIENT_EMAIL?.trim() ?? "";
  if (!to) {
    return NextResponse.json(
      { error: "recipient_required", detail: "Provide 'to' in body or set INVOICE_CLIENT_EMAIL env var" },
      { status: 400 },
    );
  }

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
  const gigSummary    = body.gigSummary?.trim() ?? "";

  const subject = body.subject?.trim()
    || (laNumber
      ? `Invoice ${invoiceNumber} — Job #${laNumber}${gigSummary ? " — " + gigSummary : ""}`
      : `Invoice ${invoiceNumber}${gigSummary ? " — " + gigSummary : ""}`);

  const note = body.note?.trim() ?? "";
  const htmlBody = buildEmailHtml({ invoiceNumber, laNumber, gigSummary, note, pdfUrl: invoiceData.invoice_pdf_url });
  const textBody = buildEmailText({ invoiceNumber, laNumber, gigSummary, note, pdfUrl: invoiceData.invoice_pdf_url });

  const fromName  = env.INVOICE_FROM_NAME ?? "Jeff Ulsh";
  const fromEmail = env.NOTIFY_EMAIL_FROM?.trim() ?? "invoices@resend.dev";
  const from      = fromEmail.includes("<") ? fromEmail : `${fromName} <${fromEmail}>`;

  const resend = new Resend(env.RESEND_API_KEY);
  const { error: sendError } = await resend.emails.send({
    from,
    to: [to],
    subject,
    html: htmlBody,
    text: textBody,
  });

  if (sendError) {
    console.error(`[invoice/email] send failed: ${JSON.stringify(sendError)}`);
    return NextResponse.json(
      { error: "send_failed", detail: String(sendError) },
      { status: 502 },
    );
  }

  // Only mark sent AFTER successful delivery
  const sentAt = new Date().toISOString();
  await markInvoiceSent(params.eventId, sentAt);

  return NextResponse.json({ ok: true, to, sentAt, subject });
}

// ---------------------------------------------------------------------------
// Email templates
// ---------------------------------------------------------------------------

interface EmailParams {
  invoiceNumber: string;
  laNumber: string;
  gigSummary: string;
  note: string;
  pdfUrl: string;
}

function buildEmailHtml(p: EmailParams): string {
  const jobLine = [p.laNumber && `Job #${p.laNumber}`, p.gigSummary].filter(Boolean).join(" — ");
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Invoice ${p.invoiceNumber}</title></head>
<body style="font-family:sans-serif;color:#333;max-width:600px;margin:0 auto;padding:24px">
  <p>Hi,</p>
  <p>Please find my invoice${jobLine ? " for " + jobLine : ""} attached below.</p>
  ${p.note ? `<p>${p.note}</p>` : ""}
  <p>
    <a href="${p.pdfUrl}" style="display:inline-block;padding:10px 20px;background:#1a56a0;color:#fff;text-decoration:none;border-radius:4px">
      View / Download Invoice ${p.invoiceNumber}
    </a>
  </p>
  <p style="margin-top:32px">Thanks again,<br/>Jeff</p>
</body>
</html>`;
}

function buildEmailText(p: EmailParams): string {
  const jobLine = [p.laNumber && `Job #${p.laNumber}`, p.gigSummary].filter(Boolean).join(" — ");
  return [
    "Hi,",
    "",
    `Please find my invoice${jobLine ? " for " + jobLine : ""} at the link below.`,
    p.note ? p.note : "",
    "",
    `Invoice ${p.invoiceNumber}: ${p.pdfUrl}`,
    "",
    "Thanks again,",
    "Jeff",
  ].filter((l) => l !== undefined).join("\n");
}
