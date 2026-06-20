import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { getSheetHealthReport } from "@/lib/google-sheets";
import { classifySheetsError } from "@/lib/google-error";

export const dynamic = "force-dynamic";

/**
 * GET /api/invoice/sheet-health
 *
 * Read-only admin tool. Scans the full Sheet and reports:
 *   - Total active invoice rows (excludes VOID_DUPLICATE)
 *   - Total voided rows (STATUS = VOID_DUPLICATE)
 *   - Any keys with more than one active row (active duplicates)
 *   - Whether voided rows have zero money columns (confirms SUM accuracy)
 *   - Per-key breakdown with active rows, voided rows, and expected sync row
 *
 * Response: SheetHealthReport + sheetTarget + scannedAt
 * Never modifies the sheet.
 */
export async function GET(request: NextRequest) {
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
    const report = await getSheetHealthReport();
    return NextResponse.json({
      ...report,
      sheetTarget,
      scannedAt: new Date().toISOString(),
    });
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const friendlyMsg = classifySheetsError(err, sheetId, sheetName);
    console.error("[sheet-health] scan failed:", rawMsg);
    return NextResponse.json(
      { error: "sheet_scan_failed", message: friendlyMsg, sheetTarget },
      { status: 502 },
    );
  }
}
