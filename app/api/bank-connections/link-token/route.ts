import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest, isSameOriginEditorMutation } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { requireBankUnlock } from "@/lib/bank-admin-guard";
import { createPlaidLinkToken, requirePlaidRuntimeConfig } from "@/lib/plaid-client";
import { getDecryptedPlaidAccessToken } from "@/lib/plaid-bank-sync";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isJeffEditorId(auth.editorId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const locked = requireBankUnlock(request);
  if (locked) return locked;
  if (!isSameOriginEditorMutation(request)) return NextResponse.json({ error: "forbidden_origin" }, { status: 403 });
  let body: { connection_id?: string } = {};
  try { body = await request.json() as typeof body; }
  catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  try {
    const config = requirePlaidRuntimeConfig(env);
    const accessToken = body.connection_id
      ? await getDecryptedPlaidAccessToken(body.connection_id)
      : undefined;
    const linkToken = await createPlaidLinkToken(config, `bank-${auth.editorId}`, accessToken);
    return NextResponse.json({ link_token: linkToken, update_mode: !!accessToken });
  } catch (error) {
    return NextResponse.json({
      error: "link_token_failed",
      detail: error instanceof Error ? error.message : "Link token creation failed",
    }, { status: 502 });
  }
}
