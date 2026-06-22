import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { sanitizeInvoiceLineItemOverrides } from "@/lib/invoice-line-item-overrides";
import { getInvoiceData, upsertInvoiceData, markSheetSynced, markSheetSyncError } from "@/lib/invoice-data";
import { calculateInvoicePacket, generateSheetRow } from "@/lib/invoice-calculations";
import { upsertSheetRow } from "@/lib/google-sheets";
import type { InvoiceDataPatch } from "@/lib/invoice-data";
import type { InvoiceData, InvoicePacket, WorkdayEntry } from "@/lib/invoice-types";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ eventId: string }>;
}

function jeffOnlyResponse() {
  return NextResponse.json({ error: "forbidden" }, { status: 403 });
}

// Build the Google Sheet public URL from the env var (server-side only).
function getSheetUrl(): string | null {
  const id = process.env.GOOGLE_SHEET_ID;
  return id ? `https://docs.google.com/spreadsheets/d/${id}` : null;
}

const INVOICE_TEXT_OVERRIDE_FIELDS = [
  "invoice_job_name_override",
  "invoice_day_rate_description_override",
  "invoice_ot_description_override",
  "invoice_per_diem_description_override",
  "invoice_bag_fees_description_override",
  "invoice_parking_description_override",
  "invoice_uber_description_override",
  "invoice_tolls_description_override",
  "invoice_hotel_description_override",
  "invoice_other_description_override",
  "invoice_note_override",
] as const satisfies readonly (keyof InvoiceDataPatch)[];

type InvoiceTextOverrideField = (typeof INVOICE_TEXT_OVERRIDE_FIELDS)[number];

// Fire-and-forget sheet sync after invoice save. Logs failure but never throws.
// Records syncedAt / syncError in the DB so the client can surface the status.
function syncSheetBackground(eventId: string, data: InvoiceData, packet: InvoicePacket, gigSummary: string): void {
  void (async () => {
    try {
      const sheetRow = generateSheetRow(
        packet,
        gigSummary || data.la_number || "",
        data.invoice_number ?? undefined,
        undefined,
        {
          sentTo: data.invoice_sent_to,
          sentSubject: data.invoice_sent_subject,
          jobNameOverride: data.invoice_job_name_override,
        },
      );
      await upsertSheetRow(sheetRow);
      await markSheetSynced(eventId, new Date().toISOString());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[invoice PATCH] background sheet sync failed (non-fatal):", msg);
      try { await markSheetSyncError(eventId, msg); } catch { /* ignore secondary failure */ }
    }
  })();
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { eventId: rawEventId } = await context.params;
  const eventId = decodeURIComponent(rawEventId ?? "").trim();
  if (!eventId) {
    return NextResponse.json({ error: "missing_event_id" }, { status: 400 });
  }

  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isJeffEditorId(auth.editorId)) {
    return jeffOnlyResponse();
  }

  try {
    const data = await getInvoiceData(eventId);
    if (!data) {
      return NextResponse.json({ invoiceData: null, packet: null, sheetUrl: getSheetUrl() });
    }
    const packet = calculateInvoicePacket(data);
    return NextResponse.json({ invoiceData: data, packet, sheetUrl: getSheetUrl() });
  } catch (err) {
    console.error("[invoice GET]", err);
    return NextResponse.json({ error: "server_error" }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { eventId: rawEventId } = await context.params;
  const eventId = decodeURIComponent(rawEventId ?? "").trim();
  if (!eventId) {
    return NextResponse.json({ error: "missing_event_id" }, { status: 400 });
  }

  const { env } = getConfig();
  const auth = authorizeEditorRequest(request, env);
  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isJeffEditorId(auth.editorId)) {
    return jeffOnlyResponse();
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const b = body as Record<string, unknown>;

  // gigSummary is used for Google Sheets gigEvent column on background sync.
  // Client always sends it; if absent fall back to empty string (sheets match by laJobNumber).
  const gigSummary = typeof b.gigSummary === "string" ? b.gigSummary.trim() : "";

  const patch: InvoiceDataPatch = {};

  if ("la_number" in b) patch.la_number = b.la_number != null ? String(b.la_number) : null;
  if ("invoice_status" in b && typeof b.invoice_status === "string") {
    patch.invoice_status = b.invoice_status as InvoiceDataPatch["invoice_status"];
  }
  if ("workday_entries" in b && Array.isArray(b.workday_entries)) {
    patch.workday_entries = (b.workday_entries as WorkdayEntry[]).filter(
      (e) => e && typeof e.date === "string" && typeof e.startTime === "string" && typeof e.endTime === "string",
    );
  }
  if ("client" in b && typeof b.client === "string") patch.client = b.client;
  if ("day_rate" in b && typeof b.day_rate === "number") patch.day_rate = b.day_rate;
  if ("per_diem_rate" in b && typeof b.per_diem_rate === "number") patch.per_diem_rate = b.per_diem_rate;
  if ("overtime_rate" in b && typeof b.overtime_rate === "number") patch.overtime_rate = b.overtime_rate;
  if ("bag_fees" in b) patch.bag_fees = b.bag_fees != null ? Number(b.bag_fees) : null;
  if ("hotel" in b) patch.hotel = b.hotel != null ? Number(b.hotel) : null;
  if ("parking" in b) patch.parking = b.parking != null ? Number(b.parking) : null;
  if ("tolls" in b) patch.tolls = b.tolls != null ? Number(b.tolls) : null;
  if ("uber" in b) patch.uber = b.uber != null ? Number(b.uber) : null;
  if ("other_expenses" in b) patch.other_expenses = b.other_expenses != null ? Number(b.other_expenses) : null;
  if ("expense_notes" in b) patch.expense_notes = b.expense_notes != null ? String(b.expense_notes) : null;
  if ("job_address" in b) patch.job_address = b.job_address != null ? String(b.job_address) : null;
  if ("total_miles" in b) patch.total_miles = b.total_miles != null ? Number(b.total_miles) : null;
  if ("mileage_rate" in b && typeof b.mileage_rate === "number") patch.mileage_rate = b.mileage_rate;
  if ("mileage_deduction_miles" in b && typeof b.mileage_deduction_miles === "number") {
    patch.mileage_deduction_miles = b.mileage_deduction_miles;
  }
  if ("paid_date" in b) patch.paid_date = b.paid_date != null ? String(b.paid_date) : null;
  if ("invoice_line_item_overrides" in b) {
    patch.invoice_line_item_overrides = sanitizeInvoiceLineItemOverrides(b.invoice_line_item_overrides);
  }
  for (const field of INVOICE_TEXT_OVERRIDE_FIELDS) {
    if (field in b) {
      patch[field as InvoiceTextOverrideField] = b[field] != null ? String(b[field]) : null;
    }
  }

  try {
    const data = await upsertInvoiceData(eventId, patch);
    const packet = calculateInvoicePacket(data);
    // Background sheet sync — non-blocking; failures are logged, never surface to client.
    // gigSummary must be sent by the client for gigEvent to be accurate; falls back to la_number.
    syncSheetBackground(eventId, data, packet, gigSummary);
    return NextResponse.json({ invoiceData: data, packet });
  } catch (err) {
    console.error("[invoice PATCH]", err);
    return NextResponse.json({ error: "server_error" }, { status: 503 });
  }
}
