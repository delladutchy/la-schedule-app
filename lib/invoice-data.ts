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
    // Native invoicing fields
    invoice_number: row.invoice_number != null ? String(row.invoice_number) : null,
    invoice_pdf_url: row.invoice_pdf_url != null ? String(row.invoice_pdf_url) : null,
    invoice_created_at: row.invoice_created_at != null ? String(row.invoice_created_at) : null,
    invoice_sent_at: row.invoice_sent_at != null ? String(row.invoice_sent_at) : null,
    invoice_sent_to: row.invoice_sent_to != null ? String(row.invoice_sent_to) : null,
    invoice_sent_subject: row.invoice_sent_subject != null ? String(row.invoice_sent_subject) : null,
    invoice_total: row.invoice_total != null ? Number(row.invoice_total) : null,
    invoice_job_name_override: row.invoice_job_name_override != null ? String(row.invoice_job_name_override) : null,
    invoice_day_rate_description_override: row.invoice_day_rate_description_override != null ? String(row.invoice_day_rate_description_override) : null,
    invoice_ot_description_override: row.invoice_ot_description_override != null ? String(row.invoice_ot_description_override) : null,
    invoice_per_diem_description_override: row.invoice_per_diem_description_override != null ? String(row.invoice_per_diem_description_override) : null,
    invoice_bag_fees_description_override: row.invoice_bag_fees_description_override != null ? String(row.invoice_bag_fees_description_override) : null,
    invoice_parking_description_override: row.invoice_parking_description_override != null ? String(row.invoice_parking_description_override) : null,
    invoice_uber_description_override: row.invoice_uber_description_override != null ? String(row.invoice_uber_description_override) : null,
    invoice_tolls_description_override: row.invoice_tolls_description_override != null ? String(row.invoice_tolls_description_override) : null,
    invoice_hotel_description_override: row.invoice_hotel_description_override != null ? String(row.invoice_hotel_description_override) : null,
    invoice_other_description_override: row.invoice_other_description_override != null ? String(row.invoice_other_description_override) : null,
    invoice_note_override: row.invoice_note_override != null ? String(row.invoice_note_override) : null,
    amount_paid: Number(row.amount_paid ?? 0),
    remaining_balance: row.remaining_balance != null ? Number(row.remaining_balance) : null,
    // QuickBooks fields (require scripts/qb-migration.sql)
    quickbooks_invoice_id: row.quickbooks_invoice_id != null ? String(row.quickbooks_invoice_id) : null,
    quickbooks_invoice_link: row.quickbooks_invoice_link != null ? String(row.quickbooks_invoice_link) : null,
    quickbooks_synced_at: row.quickbooks_synced_at != null ? String(row.quickbooks_synced_at) : null,
    quickbooks_sync_error: row.quickbooks_sync_error != null ? String(row.quickbooks_sync_error) : null,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

/** Lightweight invoice row for payment-matching and reconciliation UIs. */
export interface InvoiceListItem {
  google_event_id:  string;
  invoice_number:   string | null;
  la_number:        string | null;
  invoice_total:    number | null;
  amount_paid:      number;
  remaining_balance: number | null;
  invoice_status:   InvoiceStatus;
  invoice_sent_at:  string | null;
}

/**
 * Returns all invoice_data rows that have an invoice_total (PDF created).
 * Used to populate the payments page invoice picker and smart-match logic.
 * Ordered: newest invoice first.
 */
export async function listInvoicesForPayments(): Promise<InvoiceListItem[]> {
  const client = getSupabaseServerClient();
  const { data, error } = await client
    .from("invoice_data")
    .select(
      "google_event_id, invoice_number, la_number, invoice_total, amount_paid, remaining_balance, invoice_status, invoice_sent_at",
    )
    .not("invoice_total", "is", null)
    .order("invoice_number", { ascending: false });

  if (error) throw new Error(`[invoice-data] list-for-payments failed: ${error.message}`);

  return (data ?? []).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      google_event_id:  String(r.google_event_id  ?? ""),
      invoice_number:   r.invoice_number   != null ? String(r.invoice_number)   : null,
      la_number:        r.la_number        != null ? String(r.la_number)        : null,
      invoice_total:    r.invoice_total    != null ? Number(r.invoice_total)    : null,
      amount_paid:      Number(r.amount_paid ?? 0),
      remaining_balance: r.remaining_balance != null ? Number(r.remaining_balance) : null,
      invoice_status:   (r.invoice_status as InvoiceStatus) ?? "none",
      invoice_sent_at:  r.invoice_sent_at  != null ? String(r.invoice_sent_at)  : null,
    };
  });
}

/** Returns all stored invoice_number values (non-null) from every row. Used to compute the next sequential number. */
export async function getAllInvoiceNumbers(): Promise<string[]> {
  const client = getSupabaseServerClient();
  const { data, error } = await client
    .from("invoice_data")
    .select("invoice_number")
    .not("invoice_number", "is", null);

  if (error) throw new Error(`[invoice-data] get-all-invoice-numbers failed: ${error.message}`);
  return (data ?? [])
    .map((row) => (row as Record<string, unknown>).invoice_number)
    .filter((n): n is string => typeof n === "string" && n.length > 0);
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
  // Native invoicing fields
  invoice_number?: string | null;
  invoice_pdf_url?: string | null;
  invoice_created_at?: string | null;
  invoice_sent_at?: string | null;
  invoice_sent_to?: string | null;
  invoice_sent_subject?: string | null;
  invoice_total?: number | null;
  invoice_job_name_override?: string | null;
  invoice_day_rate_description_override?: string | null;
  invoice_ot_description_override?: string | null;
  invoice_per_diem_description_override?: string | null;
  invoice_bag_fees_description_override?: string | null;
  invoice_parking_description_override?: string | null;
  invoice_uber_description_override?: string | null;
  invoice_tolls_description_override?: string | null;
  invoice_hotel_description_override?: string | null;
  invoice_other_description_override?: string | null;
  invoice_note_override?: string | null;
  amount_paid?: number;
  remaining_balance?: number | null;
  // QB fields (require scripts/qb-migration.sql applied)
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

export async function markInvoicePdfCreated(
  googleEventId: string,
  opts: {
    invoiceNumber: string;
    pdfUrl: string;
    total: number;
    createdAt: string;
  },
): Promise<InvoiceData> {
  const client = getSupabaseServerClient();

  const { data: existing, error: readError } = await client
    .from("invoice_data")
    .select("invoice_status, amount_paid")
    .eq("google_event_id", googleEventId)
    .maybeSingle();

  if (readError) throw new Error(`[invoice-data] mark-pdf-created read failed: ${readError.message}`);

  const currentStatus = ((existing as Record<string, unknown> | null)?.invoice_status as InvoiceStatus | undefined) ?? "none";
  const amountPaid = Number((existing as Record<string, unknown> | null)?.amount_paid ?? 0);
  const resetWorkflow = ["none", "ready", "sheet_synced"].includes(currentStatus);

  const patch: Record<string, unknown> = {
    invoice_number: opts.invoiceNumber,
    invoice_pdf_url: opts.pdfUrl,
    invoice_total: opts.total,
    invoice_created_at: opts.createdAt,
    updated_at: opts.createdAt,
  };

  if (resetWorkflow) {
    patch.amount_paid = 0;
    patch.remaining_balance = opts.total;
    patch.invoice_status = "sheet_synced";
  } else {
    // Always recalculate balance when total changes (sent/partially_paid/paid/draft_created)
    patch.remaining_balance = Math.max(Number((opts.total - amountPaid).toFixed(2)), 0);
  }

  const { data, error } = await client
    .from("invoice_data")
    .update(patch)
    .eq("google_event_id", googleEventId)
    .select()
    .single();

  if (error) throw new Error(`[invoice-data] mark-pdf-created failed: ${error.message}`);
  if (!data) throw new Error("[invoice-data] mark-pdf-created returned no row");
  return coerceInvoiceData(data as Record<string, unknown>);
}

export async function markInvoiceSent(
  googleEventId: string,
  sentAt: string,
  sentTo?: string | null,
  sentSubject?: string | null,
): Promise<void> {
  const client = getSupabaseServerClient();
  const patch: Record<string, unknown> = {
    invoice_sent_at: sentAt,
    invoice_status: "sent",
    updated_at: sentAt,
  };
  if (sentTo != null) patch.invoice_sent_to = sentTo;
  if (sentSubject != null) patch.invoice_sent_subject = sentSubject;

  const { error } = await client
    .from("invoice_data")
    .update(patch)
    .eq("google_event_id", googleEventId)
    .in("invoice_status", ["sheet_synced", "draft_created", "sent"]);

  if (error) throw new Error(`[invoice-data] mark-sent failed: ${error.message}`);
}

/**
 * Recalculate and persist payment fields after allocations change.
 * Called by payment allocation API after any create/delete.
 */
export async function updateInvoicePaymentTotals(
  googleEventId: string,
  opts: {
    amountPaid: number;
    invoiceTotal: number;
  },
): Promise<void> {
  const client = getSupabaseServerClient();
  const now = new Date().toISOString();
  const remainingBalance = Math.max(0, opts.invoiceTotal - opts.amountPaid);
  const amountPaid = Math.min(opts.amountPaid, opts.invoiceTotal);

  let newStatus: InvoiceStatus;
  if (amountPaid <= 0) {
    newStatus = "sent"; // no payment → revert to sent
  } else if (remainingBalance <= 0.005) {
    newStatus = "paid";
  } else {
    newStatus = "partially_paid";
  }

  const { error } = await client
    .from("invoice_data")
    .update({
      amount_paid: amountPaid,
      remaining_balance: remainingBalance,
      invoice_status: newStatus,
      paid_date: newStatus === "paid" ? now.slice(0, 10) : null,
      updated_at: now,
    })
    .eq("google_event_id", googleEventId);

  if (error) throw new Error(`[invoice-data] update-payment-totals failed: ${error.message}`);
}

// ── QuickBooks helpers (require scripts/qb-migration.sql) ────────────────────

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
