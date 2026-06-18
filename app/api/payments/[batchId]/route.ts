/**
 * GET    /api/payments/[batchId]  — get a single batch + its allocations
 * PATCH  /api/payments/[batchId]  — update batch metadata
 * DELETE /api/payments/[batchId]  — delete batch (CASCADE removes allocations)
 */
import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import {
  getPaymentBatch,
  updatePaymentBatch,
  deletePaymentBatch,
  listAllocationsForBatch,
} from "@/lib/payment-batches";

export const dynamic = "force-dynamic";

function jeffOnly(request: NextRequest) {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return { ok: false as const, status: 401 as const };
  if (!isJeffEditorId(auth.editorId)) return { ok: false as const, status: 403 as const };
  return { ok: true as const };
}

export async function GET(
  request: NextRequest,
  { params }: { params: { batchId: string } },
): Promise<NextResponse> {
  const auth = jeffOnly(request);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: auth.status });

  const [batch, allocations] = await Promise.all([
    getPaymentBatch(params.batchId),
    listAllocationsForBatch(params.batchId),
  ]);
  if (!batch) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const allocatedTotal = allocations.reduce((s, a) => s + a.allocated_amount, 0);
  return NextResponse.json({ batch: { ...batch, allocatedTotal }, allocations });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { batchId: string } },
): Promise<NextResponse> {
  const auth = jeffOnly(request);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: auth.status });

  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }

  const batch = await updatePaymentBatch(params.batchId, body as Parameters<typeof updatePaymentBatch>[1]);
  return NextResponse.json({ batch });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { batchId: string } },
): Promise<NextResponse> {
  const auth = jeffOnly(request);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: auth.status });

  await deletePaymentBatch(params.batchId);
  return NextResponse.json({ ok: true });
}
