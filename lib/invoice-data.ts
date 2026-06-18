import "server-only";
import { getSupabaseServerClient } from "./supabase";
import type { InvoiceData, InvoiceStatus, WorkdayEntry } from "./invoice-types";

export type { InvoiceData };

function coerceInvoiceData(row: Record<string, unknown>): InvoiceData {
  return {
    id: String(row.id ?? ""),
    google_event_id: String(row.google_event_id ?? ""),
    la_number: row.la_number != null ? String(row.la_number) : null,
    invoice_status: (row.invoice_status as InvoiceStatus) ?? "none",
    workday_entries: Array.isArray(row.workday_entries) ? (row.workday_entries as WorkdayEntry[]) : [],
    client: String(row.client ?? "Light Action"),
    day_rate: Number(row.day_rate ?? 550),
    per_diem_rate: Number(row.per_diem_rate ?? 40),
    overtime_rate: Number(row.overtime_rate ?? 82.5),
    bag_fees: row.bag_fees != null ? Number(row.bag_fees) : null,
    hotel: row.hotel != null ? Number(row.hotel) : null,
    parking: row.parking != null ? Number(row.parking) : null,
    tolls: row.tolls != null ? Number(row.tolls) : null,
    uber: row.uber != null ? Number(row.uber) : null,
    other_expenses: row.other_expenses != null ? Number(row.other_expenses) : null,
    expense_notes: row.expense_notes != null ? String(row.expense_notes) : null,
    job_address: row.job_address != null ? String(row.job_address) : null,
    total_miles: row.total_miles != null ? Number(row.total_miles) : null,
    mileage_rate: Number(row.mileage_rate ?? 0.52),
    mileage_deduction_miles: Number(row.mileage_deduction_miles ?? 60),
    sheet_synced_at: row.sheet_synced_at != null ? String(row.sheet_synced_at) : null,
    sheet_sync_error: row.sheet_sync_error != null ? String(row.sheet_sync_error) : null,
    paid_date: row.paid_date != null ? String(row.paid_date) : null,
    quickbooks_invoice_id: row.quickbooks_invoice_id != null ? String(row.quickbooks_invoice_id) : null,
    quickbooks_invoice_link: row.quickbooks_invoice_link != null ? String(row.quickbooks_invoice_link) : null,
    quickbooks_synced_at: row.quickbooks_synced_at != null ? String(row.quickbooks_synced_at) : null,
    quickbooks_sync_error: row.quickbooks_sync_error != null ? String(row.quickbooks_sync_error) : null,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

export async function getInvoiceData(googleEventId: string): Promise<InvoiceData | null> {
  const client = getSupabaseServerClient();
  const { data, error } = await client
    .from("invoice_data")
    .select("*")
    .eq("google_event_id", googleEventId)
    .maybeSingle();

  if (error) throw new Error(`[invoice-data] read failed: ${error.message}`);
  if (!data) return null;
  return coerceInvoiceData(data as Record<string, unknown>);
}

export interface InvoiceDataPatch {
  la_number?: string | null;
  invoice_status?: InvoiceStatus;
  workday_entries?: WorkdayEntry[];
  client?: string;
  day_rate?: number;
  per_diem_rate?: number;
  overtime_rate?: number;
  bag_fees?: number | null;
  hotel?: number | null;
  parking?: number | null;
  tolls?: number | null;
  uber?: number | null;
  other_expenses?: number | null;
  expense_notes?: string | null;
  job_address?: string | null;
  total_miles?: number | null;
  mileage_rate?: number;
  mileage_deduction_miles?: number;
  sheet_synced_at?: string | null;
  sheet_sync_error?: string | null;
  paid_date?: string | null;
  // QB fields — only writable after running scripts/qb-migration.sql
  quickbooks_invoice_id?: string | null;
  quickbooks_invoice_link?: string | null;
  quickbooks_synced_at?: string | null;
  quickbooks_sync_error?: string | null;
}

export async function upsertInvoiceData(
  googleEventId: string,
  patch: InvoiceDataPatch,
): Promise<InvoiceData> {
  const client = getSupabaseServerClient();
  const now = new Date().toISOString();

  const { data, error } = await client
    .from("invoice_data")
    .upsert(
      {
        google_event_id: googleEventId,
        ...patch,
        updated_at: now,
      },
      { onConflict: "google_event_id" },
    )
    .select()
    .single();

  if (error) throw new Error(`[invoice-data] upsert failed: ${error.message}`);
  if (!data) throw new Error("[invoice-data] upsert returned no row");
  return coerceInvoiceData(data as Record<string, unknown>);
}

export async function markSheetSynced(
  googleEventId: string,
  syncedAt: string,
): Promise<void> {
  const client = getSupabaseServerClient();
  const { error } = await client
    .from("invoice_data")
    .update({
      sheet_synced_at: syncedAt,
      sheet_sync_error: null,
      invoice_status: "sheet_synced",
      updated_at: syncedAt,
    })
    .eq("google_event_id", googleEventId);

  if (error) throw new Error(`[invoice-data] mark-synced failed: ${error.message}`);
}

export async function markSheetSyncError(
  googleEventId: string,
  errorMessage: string,
): Promise<void> {
  const client = getSupabaseServerClient();
  const now = new Date().toISOString();
  const { error } = await client
    .from("invoice_data")
    .update({
      sheet_sync_error: errorMessage,
      updated_at: now,
    })
    .eq("google_event_id", googleEventId);

  if (error) throw new Error(`[invoice-data] mark-sync-error failed: ${error.message}`);
}

// Requires: scripts/qb-migration.sql applied to the Supabase invoice_data table.
export async function markQBDraftCreated(
  googleEventId: string,
  invoiceId: string,
  invoiceLink: string,
): Promise<void> {
  const client = getSupabaseServerClient();
  const now = new Date().toISOString();
  const { error } = await client
    .from("invoice_data")
    .update({
      quickbooks_invoice_id: invoiceId,
      quickbooks_invoice_link: invoiceLink,
      quickbooks_synced_at: now,
      quickbooks_sync_error: null,
      invoice_status: "draft_created",
      updated_at: now,
    })
    .eq("google_event_id", googleEventId);

  if (error) throw new Error(`[invoice-data] mark-qb-draft failed: ${error.message}`);
}

export async function markQBSyncError(
  googleEventId: string,
  errorMessage: string,
): Promise<void> {
  const client = getSupabaseServerClient();
  const now = new Date().toISOString();
  const { error } = await client
    .from("invoice_data")
    .update({
      quickbooks_sync_error: errorMessage,
      updated_at: now,
    })
    .eq("google_event_id", googleEventId);

  if (error) throw new Error(`[invoice-data] mark-qb-error failed: ${error.message}`);
}
