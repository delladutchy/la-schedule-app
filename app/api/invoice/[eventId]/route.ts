import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import { isJeffEditorId } from "@/lib/job-time";
import { getInvoiceData, upsertInvoiceData } from "@/lib/invoice-data";
import { calculateInvoicePacket } from "@/lib/invoice-calculations";
import type { InvoiceDataPatch } from "@/lib/invoice-data";
import type { WorkdayEntry } from "@/lib/invoice-types";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ eventId: string }>;
}

function jeffOnlyResponse() {
  return NextResponse.json({ error: "forbidden" }, { status: 403 });
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
      return NextResponse.json({ invoiceData: null, packet: null });
    }
    const packet = calculateInvoicePacket(data);
    return NextResponse.json({ invoiceData: data, packet });
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

  try {
    const data = await upsertInvoiceData(eventId, patch);
    const packet = calculateInvoicePacket(data);
    return NextResponse.json({ invoiceData: data, packet });
  } catch (err) {
    console.error("[invoice PATCH]", err);
    return NextResponse.json({ error: "server_error" }, { status: 503 });
  }
}
