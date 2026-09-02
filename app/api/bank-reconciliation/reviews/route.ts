import { NextRequest, NextResponse } from "next/server";
import { getEnvConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { requireBankUnlock } from "@/lib/bank-admin-guard";
import { listOpenBankReconciliationReviews } from "@/lib/bank-transactions";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = authorizeEditorRequest(request, getEnvConfig());
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isJeffEditorId(auth.editorId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const locked = requireBankUnlock(request);
  if (locked) return locked;
  return NextResponse.json({ reviews: await listOpenBankReconciliationReviews() }, { headers: { "Cache-Control": "no-store" } });
}
