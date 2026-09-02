import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest, isSameOriginEditorMutation } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { requireBankUnlock } from "@/lib/bank-admin-guard";
import {
  completePlaidReconnect,
  disconnectPlaidConnection,
  syncPlaidConnection,
} from "@/lib/plaid-bank-sync";

export const dynamic = "force-dynamic";

function authorize(request: NextRequest) {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return { ok: false as const, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (!isJeffEditorId(auth.editorId)) return { ok: false as const, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  const locked = requireBankUnlock(request);
  if (locked) return { ok: false as const, response: locked };
  return { ok: true as const, auth };
}

export async function PATCH(
  request: NextRequest,
  context: { params: { connectionId: string } },
): Promise<NextResponse> {
  const result = authorize(request);
  if (!result.ok) return result.response;
  if (!isSameOriginEditorMutation(request)) return NextResponse.json({ error: "forbidden_origin" }, { status: 403 });
  let body: { action?: "sync" | "reconnect_complete" };
  try { body = await request.json() as typeof body; }
  catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  try {
    if (body.action === "reconnect_complete") {
      await completePlaidReconnect(context.params.connectionId, result.auth.editorId);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "sync") {
      const sync = await syncPlaidConnection(context.params.connectionId, { createdBy: result.auth.editorId });
      return NextResponse.json({ ok: true, sync });
    }
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({
      error: "bank_connection_action_failed",
      detail: error instanceof Error ? error.message : "Action failed",
    }, { status: 502 });
  }
}

export async function DELETE(
  request: NextRequest,
  context: { params: { connectionId: string } },
): Promise<NextResponse> {
  const result = authorize(request);
  if (!result.ok) return result.response;
  if (!isSameOriginEditorMutation(request)) return NextResponse.json({ error: "forbidden_origin" }, { status: 403 });
  try {
    await disconnectPlaidConnection(context.params.connectionId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({
      error: "bank_disconnect_failed",
      detail: error instanceof Error ? error.message : "Disconnect failed",
    }, { status: 502 });
  }
}
