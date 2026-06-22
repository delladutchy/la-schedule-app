/**
 * GET    /api/invoice/attachments/[id]/update — get signed URL for viewing
 * PATCH  /api/invoice/attachments/[id]/update — toggle include_in_email
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
  setAttachmentEmailFlag,
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

  if (typeof body.include_in_email !== "boolean") {
    return NextResponse.json({ error: "include_in_email_required" }, { status: 400 });
  }

  try {
    await setAttachmentEmailFlag(params.id, body.include_in_email as boolean);
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
