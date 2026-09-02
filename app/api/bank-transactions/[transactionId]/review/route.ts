import { NextRequest, NextResponse } from "next/server";
import { getEnvConfig } from "@/lib/config";
import { authorizeEditorRequest, isSameOriginEditorMutation } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { requireBankUnlock } from "@/lib/bank-admin-guard";
import { applyReviewedBankTransaction, dismissBankReconciliationReview, reconcileBankTransaction } from "@/lib/bank-transactions";
import type { AutomaticAllocation } from "@/lib/bank-reconciliation";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: { transactionId: string } }): Promise<NextResponse> {
  const auth = authorizeEditorRequest(request, getEnvConfig());
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isJeffEditorId(auth.editorId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const locked = requireBankUnlock(request);
  if (locked) return locked;
  if (!isSameOriginEditorMutation(request)) return NextResponse.json({ error: "forbidden_origin" }, { status: 403 });
  let body: { action?: "retry" | "dismiss" | "apply"; allocations?: AutomaticAllocation[] };
  try { body = await request.json() as typeof body; } catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  try {
    if (body.action === "retry") return NextResponse.json({ ok: true, decision: await reconcileBankTransaction(params.transactionId, auth.editorId) });
    if (body.action === "dismiss") {
      await dismissBankReconciliationReview(params.transactionId, auth.editorId);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "apply" && Array.isArray(body.allocations) && body.allocations.length > 0) {
      return NextResponse.json({ ok: true, paymentBatchId: await applyReviewedBankTransaction(params.transactionId, body.allocations, auth.editorId) });
    }
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: "review_action_failed", detail: error instanceof Error ? error.message : "Action failed" }, { status: 409 });
  }
}
