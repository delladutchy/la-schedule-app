import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { getInvoiceData, markSheetSynced, markSheetSyncError } from "@/lib/invoice-data";
import { calculateInvoicePacket, generateSheetRow } from "@/lib/invoice-calculations";
import { upsertSheetRow } from "@/lib/google-sheets";

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
  const row = generateSheetRow(packet, gigSummary || invoiceData.la_number || eventId);

  try {
    await upsertSheetRow(row);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[sync-sheet] sheet write failed", message);
    try {
      await markSheetSyncError(eventId, message);
    } catch {
      // Don't let a secondary DB failure hide the sheet error
    }
    return NextResponse.json(
      { error: "sheet_sync_failed", message: "Sheet sync failed — retry" },
      { status: 502 },
    );
  }

  const syncedAt = new Date().toISOString();
  try {
    await markSheetSynced(eventId, syncedAt);
  } catch (err) {
    console.error("[sync-sheet] mark-synced failed (non-fatal)", err);
    // The row was written — return partial success so UI doesn't show error
  }

  return NextResponse.json({ success: true, syncedAt });
}
