/**
 * GET  /api/invoice/attachments/[id] — list attachments for a job (id = google_event_id)
 * POST /api/invoice/attachments/[id] — upload a new attachment (id = google_event_id)
 *
 * Jeff-only. Attachments stored in Supabase Storage (private bucket).
 */

import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import {
  ensureAttachmentBucket,
  uploadAttachment,
  listAttachments,
  ALLOWED_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
} from "@/lib/invoice-attachments";
import { getInvoiceData } from "@/lib/invoice-data";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isJeffEditorId(auth.editorId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  try {
    const attachments = await listAttachments(params.id);
    return NextResponse.json({ attachments });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[invoice/attachments] list failed:", msg);
    return NextResponse.json({ error: "list_failed", detail: msg }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isJeffEditorId(auth.editorId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "invalid_form_data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file_required" }, { status: 400 });
  }

  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return NextResponse.json(
      { error: "invalid_file_type", detail: `Allowed: images and PDF. Got: ${file.type}` },
      { status: 400 },
    );
  }

  if (file.size > MAX_ATTACHMENT_BYTES) {
    return NextResponse.json(
      { error: "file_too_large", detail: `Max 20 MB. Got: ${Math.round(file.size / 1024 / 1024)}MB` },
      { status: 400 },
    );
  }

  let invoiceNumber: string | null = null;
  let laJobNumber: string | null = null;
  try {
    const data = await getInvoiceData(params.id);
    if (data) {
      invoiceNumber = data.invoice_number;
      laJobNumber = data.la_number;
    }
  } catch { /* non-fatal */ }

  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    await ensureAttachmentBucket();
    const record = await uploadAttachment({
      googleEventId: params.id,
      invoiceNumber,
      laJobNumber,
      originalFilename: file.name,
      mimeType: file.type,
      buffer,
      uploadedBy: auth.editorId ?? null,
    });
    return NextResponse.json({ attachment: record }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[invoice/attachments] upload failed:", msg);
    return NextResponse.json({ error: "upload_failed", detail: msg }, { status: 500 });
  }
}
