import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { resetSheetLayout } from "@/lib/google-sheets";
import { classifySheetsError } from "@/lib/google-error";

export const dynamic = "force-dynamic";

/**
 * POST /api/invoice/sheet-reset
 *
 * Jeff-only. Resets the Sheet to a clean state for real invoice use:
 *   1. Archives + deletes VOID_DUPLICATE rows.
 *   2. Archives + deletes fake/test rows (LA#5555, inv#1001, gig "test").
 *   3. Deduplicates remaining active rows (keeps best per key).
 *   4. Moves any good rows below TOTALS to above TOTALS.
 *   5. Rebuilds TOTALS row SUM formulas (E–S).
 *
 * Never touches invoice math, PDFs, emails, payments, calendar, or QuickBooks.
 * Never sends emails automatically.
 * Every removed row is archived to "Voided Duplicates" before deletion.
 *
 * Response: SheetResetResult + resetAt
 */
export async function POST(request: NextRequest) {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isJeffEditorId(auth.editorId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const sheetId   = process.env.GOOGLE_SHEET_ID ?? null;
  const sheetName = process.env.GOOGLE_SHEET_NAME ?? "LA PAY (2026)";
  const sheetTarget = { sheetId, sheetName };

  if (!sheetId) {
    return NextResponse.json(
      { error: "sheet_not_configured", message: "GOOGLE_SHEET_ID env var not configured", sheetTarget },
      { status: 503 },
    );
  }

  try {
    const result = await resetSheetLayout();
    return NextResponse.json({
      ...result,
      sheetTarget,
      resetAt: new Date().toISOString(),
    });
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const friendlyMsg = classifySheetsError(err, sheetId, sheetName);
    console.error("[sheet-reset] reset failed:", rawMsg);
    return NextResponse.json(
      { error: "sheet_reset_failed", message: friendlyMsg, sheetTarget },
      { status: 502 },
    );
  }
}
