/**
 * GET /api/invoice/list
 *
 * Jeff-only. Returns all invoices that have been generated (invoice_total set),
 * with payment status fields. Used by:
 *   - /admin/payments invoice picker dropdown
 *   - Client-side smart payment matching
 */
import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { listInvoicesForPayments } from "@/lib/invoice-data";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isJeffEditorId(auth.editorId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const invoices = await listInvoicesForPayments();
  return NextResponse.json({ invoices });
}
