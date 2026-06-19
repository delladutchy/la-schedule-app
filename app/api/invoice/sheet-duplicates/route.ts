import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { findSheetDuplicates } from "@/lib/google-sheets";
import { classifySheetsError } from "@/lib/google-error";

export const dynamic = "force-dynamic";

/**
 * GET /api/invoice/sheet-duplicates
 *
 * Read-only. Scans the Google Sheet for duplicate invoice rows (same LA# or
 * invoice number) and returns a structured report.  Never modifies the sheet.
 *
 * Response:
 *   { duplicates: SheetDuplicateGroup[]; totalDuplicateRows: number; sheetTarget: {...} }
 *
 * Each group includes:
 *   key        — canonical key used ("la:5555" or "inv:1001")
 *   rows       — array of { rowNumber, invNumber, laNumber, date, total }
 *   keepRow    — row number to keep (latest sync)
 *   deleteRows — row numbers safe to delete after review
 *
 * Callers should review the response before deleting anything.
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
    const duplicates = await findSheetDuplicates();
    const totalDuplicateRows = duplicates.reduce((sum, g) => sum + g.deleteRows.length, 0);
    return NextResponse.json({ duplicates, totalDuplicateRows, sheetTarget });
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const friendlyMsg = classifySheetsError(err, sheetId, sheetName);
    console.error("[sheet-duplicates] read failed:", rawMsg);
    return NextResponse.json(
      { error: "sheet_read_failed", message: friendlyMsg, sheetTarget },
      { status: 502 },
    );
  }
}
