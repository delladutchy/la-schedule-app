import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { repairSheetLayout } from "@/lib/google-sheets";
import { classifySheetsError } from "@/lib/google-error";

export const dynamic = "force-dynamic";

/**
 * POST /api/invoice/sheet-repair
 *
 * Jeff-only. Repairs the Sheet layout:
 *   1. Archives + deletes VOID_DUPLICATE rows still on the main sheet.
 *   2. Archives + deletes active duplicate rows below TOTALS (key exists above).
 *   3. Moves active orphan rows from below TOTALS to above TOTALS.
 *
 * Nothing is permanently deleted unless it was first archived to "Voided Duplicates".
 * Unrelated rows and rows already above TOTALS are never touched.
 *
 * Response: SheetRepairResult + repairedAt
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
    const result = await repairSheetLayout();
    return NextResponse.json({
      ...result,
      sheetTarget,
      repairedAt: new Date().toISOString(),
    });
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const friendlyMsg = classifySheetsError(err, sheetId, sheetName);
    console.error("[sheet-repair] repair failed:", rawMsg);
    return NextResponse.json(
      { error: "sheet_repair_failed", message: friendlyMsg, sheetTarget },
      { status: 502 },
    );
  }
}
