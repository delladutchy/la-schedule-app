import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { getInvoiceData, markSheetSynced, markSheetSyncError } from "@/lib/invoice-data";
import { calculateInvoicePacket, generateSheetRow } from "@/lib/invoice-calculations";
import { upsertSheetRow } from "@/lib/google-sheets";
import { classifySheetsError } from "@/lib/google-error";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isJeffEditorId(auth.editorId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const eventId = typeof b.eventId === "string" ? b.eventId.trim() : "";
  const gigSummary = typeof b.gigSummary === "string" ? b.gigSummary.trim() : "";

  if (!eventId) {
    return NextResponse.json({ error: "missing_event_id" }, { status: 400 });
  }

  // Expose which spreadsheet/tab is the sync target so the client can verify.
  const sheetId = process.env.GOOGLE_SHEET_ID ?? null;
  const sheetName = process.env.GOOGLE_SHEET_NAME ?? "LA PAY (2026)";
  const sheetTarget = { sheetId, sheetName };

  if (!sheetId) {
    return NextResponse.json(
      {
        error: "sheet_not_configured",
        message: "GOOGLE_SHEET_ID env var not configured",
        sheetTarget,
      },
      { status: 503 },
    );
  }

  let invoiceData;
  try {
    invoiceData = await getInvoiceData(eventId);
  } catch (err) {
    console.error("[sync-sheet] read failed", err);
    return NextResponse.json({ error: "server_error" }, { status: 503 });
  }

  if (!invoiceData) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const packet = calculateInvoicePacket(invoiceData);
  const row = generateSheetRow(packet, gigSummary || invoiceData.la_number || eventId, undefined, undefined, {
    sentTo: invoiceData.invoice_sent_to,
    sentSubject: invoiceData.invoice_sent_subject,
    jobNameOverride: invoiceData.invoice_job_name_override,
    dayRateDescriptionOverride: invoiceData.invoice_day_rate_description_override,
    noteOverride: invoiceData.invoice_note_override,
  });

  let upsertResult;
  try {
    upsertResult = await upsertSheetRow(row);
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const friendlyMsg = classifySheetsError(err, sheetId, sheetName);
    console.error("[sync-sheet] sheet write failed:", rawMsg);
    try {
      await markSheetSyncError(eventId, rawMsg);
    } catch {
      // Don't let a secondary DB failure hide the sheet error
    }
    return NextResponse.json(
      { error: "sheet_sync_failed", message: friendlyMsg, sheetTarget },
      { status: 502 },
    );
  }

  const syncedAt = new Date().toISOString();
  try {
    await markSheetSynced(eventId, syncedAt);
  } catch (err) {
    console.error("[sync-sheet] mark-synced failed (non-fatal)", err);
    // The row was written — return success so UI doesn't show error
  }

  return NextResponse.json({
    success: true,
    syncedAt,
    sheetTarget,
    hasDuplicates: upsertResult.hasDuplicates,
    archivedRows: upsertResult.archivedRows,
    keptRow: upsertResult.rowNumber,
  });
}
