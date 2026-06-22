/**
 * GET    /api/invoice/attachments/[id]/update — get signed URL for viewing
 * PATCH  /api/invoice/attachments/[id]/update — update email flag and/or receipt metadata
 * DELETE /api/invoice/attachments/[id]/update — archive (soft-delete) attachment
 *
 * Jeff-only.
 */

import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import {
  archiveAttachment,
  updateAttachmentMetadata,
  getAttachmentSignedUrl,
} from "@/lib/invoice-attachments";

export const dynamic = "force-dynamic";

function authCheck(request: NextRequest): { ok: true } | { ok: false; error: string; status: number } {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return { ok: false, error: "unauthorized", status: 401 };
  if (!isJeffEditorId(auth.editorId)) return { ok: false, error: "forbidden", status: 403 };
  return { ok: true };
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const check = authCheck(request);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

  try {
    const signedUrl = await getAttachmentSignedUrl(params.id, 3600);
    if (!signedUrl) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ signedUrl });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "signed_url_failed", detail: msg }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const check = authCheck(request);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const updates: Parameters<typeof updateAttachmentMetadata>[1] = {};

  if ("include_in_email" in body) {
    if (typeof body.include_in_email !== "boolean") {
      return NextResponse.json({ error: "include_in_email_must_be_boolean" }, { status: 400 });
    }
    updates.include_in_email = body.include_in_email;
  }
  if ("receipt_date" in body) {
    updates.receipt_date = (typeof body.receipt_date === "string" && body.receipt_date) ? body.receipt_date : null;
  }
  if ("receipt_category" in body) {
    updates.receipt_category = (typeof body.receipt_category === "string" && body.receipt_category) ? body.receipt_category : null;
  }
  if ("receipt_amount" in body) {
    const amt = body.receipt_amount;
    updates.receipt_amount = (typeof amt === "number" && !isNaN(amt)) ? amt : null;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "no_fields_provided" }, { status: 400 });
  }

  try {
    await updateAttachmentMetadata(params.id, updates);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "update_failed", detail: msg }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const check = authCheck(request);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

  try {
    await archiveAttachment(params.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "archive_failed", detail: msg }, { status: 500 });
  }
}
