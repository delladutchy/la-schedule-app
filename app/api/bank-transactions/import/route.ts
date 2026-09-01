import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { parseWellsFargoCsv } from "@/lib/wells-fargo-csv";
import { importBankTransactions } from "@/lib/bank-transactions";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isJeffEditorId(auth.editorId)) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let body: { provider: string; csv: string; source_account?: string | null; auto_reconcile?: boolean };
  try { body = await request.json() as typeof body; }
  catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  if (body.provider !== "wells_fargo_csv") {
    return NextResponse.json({ error: "unsupported_provider" }, { status: 400 });
  }
  if (typeof body.csv !== "string" || body.csv.length === 0 || body.csv.length > 5_000_000) {
    return NextResponse.json({ error: "invalid_csv" }, { status: 400 });
  }

  try {
    const parsed = parseWellsFargoCsv(body.csv, body.source_account ?? null);
    const results = await importBankTransactions(parsed, {
      autoReconcile: body.auto_reconcile !== false,
      createdBy: auth.editorId,
    });
    return NextResponse.json({ parsed: parsed.length, results });
  } catch (error) {
    return NextResponse.json({
      error: "bank_import_failed",
      detail: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
