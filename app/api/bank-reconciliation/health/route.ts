import { NextRequest, NextResponse } from "next/server";
import { getEnvConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { getBankReconciliationHealth } from "@/lib/bank-reconciliation-health";

export const dynamic = "force-dynamic";

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const env = getEnvConfig();
  const auth = authorizeEditorRequest(request, env);
  const bearer = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  if (!(auth.ok && isJeffEditorId(auth.editorId)) && !constantTimeEqual(bearer, env.ADMIN_TOKEN)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await getBankReconciliationHealth(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "health_check_failed" }, { status: 500 });
  }
}
