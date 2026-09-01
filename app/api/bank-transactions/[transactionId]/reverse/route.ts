import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { reverseBankTransactionReconciliation } from "@/lib/bank-transactions";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: { transactionId: string } },
): Promise<NextResponse> {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isJeffEditorId(auth.editorId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  try {
    const eventIds = await reverseBankTransactionReconciliation(params.transactionId);
    return NextResponse.json({ ok: true, eventIds });
  } catch (error) {
    return NextResponse.json({
      error: "reversal_failed",
      detail: error instanceof Error ? error.message : String(error),
    }, { status: 409 });
  }
}
