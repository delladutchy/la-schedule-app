/**
 * GET  /api/payments  — list all payment batches with allocation totals
 * POST /api/payments  — create a new payment batch
 */
import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { createPaymentBatch, listBatchesWithSummary } from "@/lib/payment-batches";

export const dynamic = "force-dynamic";

function jeffOnly(request: NextRequest) {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return { ok: false, status: 401 as const };
  if (!isJeffEditorId(auth.editorId)) return { ok: false, status: 403 as const };
  return { ok: true, editorId: auth.editorId };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = jeffOnly(request);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: auth.status });

  const batches = await listBatchesWithSummary();
  return NextResponse.json({ batches });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = jeffOnly(request);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: auth.status });

  let body: {
    received_date: string;
    amount: number;
    client_name?: string;
    payment_method?: string;
    bank_account?: string | null;
    reference?: string | null;
    notes?: string | null;
  };
  try {
    body = await request.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  if (!body.received_date || !body.amount || body.amount <= 0) {
    return NextResponse.json(
      { error: "validation_failed", detail: "received_date and amount (> 0) are required" },
      { status: 400 },
    );
  }

  const batch = await createPaymentBatch({
    ...body,
    created_by: "editorId" in auth ? auth.editorId : null,
  });

  return NextResponse.json({ batch }, { status: 201 });
}
