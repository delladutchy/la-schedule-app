import "server-only";
import { getSupabaseServerClient } from "./supabase";
import { round2 } from "./invoice-calculations";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PaymentBatch {
  id: string;
  client_name: string;
  received_date: string;  // YYYY-MM-DD
  amount: number;
  payment_method: string;
  bank_account: string | null;
  reference: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  // Computed client-side: sum of all allocations for this batch
  allocated?: number;
  unallocated?: number;
}

export interface PaymentAllocation {
  id: string;
  payment_batch_id: string;
  google_event_id: string;
  allocated_amount: number;
  created_at: string;
  // Joined from invoice_data:
  invoice_number?: string | null;
  la_number?: string | null;
  invoice_total?: number | null;
  amount_paid?: number;
  remaining_balance?: number | null;
  invoice_status?: string;
}

export interface CreateBatchInput {
  client_name?: string;
  received_date: string;
  amount: number;
  payment_method?: string;
  bank_account?: string | null;
  reference?: string | null;
  notes?: string | null;
  created_by?: string | null;
}

// ---------------------------------------------------------------------------
// Payment Batches
// ---------------------------------------------------------------------------

function coerceBatch(row: Record<string, unknown>): PaymentBatch {
  return {
    id:             String(row.id ?? ""),
    client_name:    String(row.client_name ?? "Light Action"),
    received_date:  String(row.received_date ?? ""),
    amount:         Number(row.amount ?? 0),
    payment_method: String(row.payment_method ?? "Direct Deposit"),
    bank_account:   row.bank_account != null ? String(row.bank_account) : null,
    reference:      row.reference    != null ? String(row.reference)    : null,
    notes:          row.notes        != null ? String(row.notes)        : null,
    created_at:     String(row.created_at ?? ""),
    updated_at:     String(row.updated_at ?? ""),
    created_by:     row.created_by   != null ? String(row.created_by)  : null,
  };
}

export async function listPaymentBatches(): Promise<PaymentBatch[]> {
  const client = getSupabaseServerClient();
  const { data, error } = await client
    .from("payment_batches")
    .select("*")
    .order("received_date", { ascending: false });

  if (error) throw new Error(`[payments] list-batches failed: ${error.message}`);
  return (data ?? []).map((r) => coerceBatch(r as Record<string, unknown>));
}

export async function getPaymentBatch(id: string): Promise<PaymentBatch | null> {
  const client = getSupabaseServerClient();
  const { data, error } = await client
    .from("payment_batches")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`[payments] get-batch failed: ${error.message}`);
  if (!data) return null;
  return coerceBatch(data as Record<string, unknown>);
}

export async function createPaymentBatch(input: CreateBatchInput): Promise<PaymentBatch> {
  const client = getSupabaseServerClient();
  const { data, error } = await client
    .from("payment_batches")
    .insert({
      client_name:    input.client_name    ?? "Light Action",
      received_date:  input.received_date,
      amount:         round2(input.amount),
      payment_method: input.payment_method ?? "Direct Deposit",
      bank_account:   input.bank_account   ?? null,
      reference:      input.reference      ?? null,
      notes:          input.notes          ?? null,
      created_by:     input.created_by     ?? null,
    })
    .select()
    .single();

  if (error) throw new Error(`[payments] create-batch failed: ${error.message}`);
  if (!data) throw new Error("[payments] create-batch returned no row");
  return coerceBatch(data as Record<string, unknown>);
}

export async function updatePaymentBatch(
  id: string,
  patch: Partial<Omit<CreateBatchInput, "created_by">>,
): Promise<PaymentBatch> {
  const client = getSupabaseServerClient();
  const updates: Record<string, unknown> = {};
  if (patch.client_name    !== undefined) updates.client_name    = patch.client_name;
  if (patch.received_date  !== undefined) updates.received_date  = patch.received_date;
  if (patch.amount         !== undefined) updates.amount         = round2(patch.amount);
  if (patch.payment_method !== undefined) updates.payment_method = patch.payment_method;
  if (patch.bank_account   !== undefined) updates.bank_account   = patch.bank_account;
  if (patch.reference      !== undefined) updates.reference      = patch.reference;
  if (patch.notes          !== undefined) updates.notes          = patch.notes;

  const { data, error } = await client
    .from("payment_batches")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) throw new Error(`[payments] update-batch failed: ${error.message}`);
  if (!data) throw new Error("[payments] update-batch: not found");
  return coerceBatch(data as Record<string, unknown>);
}

export async function deletePaymentBatch(id: string): Promise<void> {
  const client = getSupabaseServerClient();
  // Allocations are CASCADE deleted.
  const { error } = await client
    .from("payment_batches")
    .delete()
    .eq("id", id);

  if (error) throw new Error(`[payments] delete-batch failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Allocations
// ---------------------------------------------------------------------------

function coerceAllocation(row: Record<string, unknown>): PaymentAllocation {
  return {
    id:                  String(row.id ?? ""),
    payment_batch_id:    String(row.payment_batch_id ?? ""),
    google_event_id:     String(row.google_event_id ?? ""),
    allocated_amount:    Number(row.allocated_amount ?? 0),
    created_at:          String(row.created_at ?? ""),
    // Invoice join fields (present if queried with join)
    invoice_number:   row.invoice_number   != null ? String(row.invoice_number)           : null,
    la_number:        row.la_number        != null ? String(row.la_number)                : null,
    invoice_total:    row.invoice_total    != null ? Number(row.invoice_total)             : null,
    amount_paid:      row.amount_paid      != null ? Number(row.amount_paid)              : 0,
    remaining_balance: row.remaining_balance != null ? Number(row.remaining_balance)      : null,
    invoice_status:   row.invoice_status   != null ? String(row.invoice_status)           : undefined,
  };
}

export async function listAllocationsForBatch(batchId: string): Promise<PaymentAllocation[]> {
  const client = getSupabaseServerClient();
  const { data, error } = await client
    .from("payment_batch_allocations")
    .select("*")
    .eq("payment_batch_id", batchId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`[payments] list-allocations failed: ${error.message}`);
  return (data ?? []).map((r) => coerceAllocation(r as Record<string, unknown>));
}

export async function listAllocationsForInvoice(googleEventId: string): Promise<PaymentAllocation[]> {
  const client = getSupabaseServerClient();
  const { data, error } = await client
    .from("payment_batch_allocations")
    .select("*, payment_batches(received_date, payment_method, reference)")
    .eq("google_event_id", googleEventId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`[payments] list-invoice-allocations failed: ${error.message}`);
  return (data ?? []).map((r) => coerceAllocation(r as Record<string, unknown>));
}

export interface CreateAllocationInput {
  payment_batch_id: string;
  google_event_id:  string;
  allocated_amount: number;
}

/**
 * Create an allocation and update the invoice's payment totals.
 * Returns the allocation row plus the updated invoice totals.
 */
export async function createAllocation(
  input: CreateAllocationInput,
  invoiceTotal: number,
): Promise<{ allocation: PaymentAllocation; newAmountPaid: number; newRemainingBalance: number }> {
  const client = getSupabaseServerClient();

  const { data, error } = await client
    .from("payment_batch_allocations")
    .insert({
      payment_batch_id: input.payment_batch_id,
      google_event_id:  input.google_event_id,
      allocated_amount: round2(input.allocated_amount),
    })
    .select()
    .single();

  if (error) throw new Error(`[payments] create-allocation failed: ${error.message}`);
  if (!data) throw new Error("[payments] create-allocation returned no row");

  const totals = await recalcInvoicePayments(input.google_event_id, invoiceTotal);
  return { allocation: coerceAllocation(data as Record<string, unknown>), ...totals };
}

export async function deleteAllocation(
  allocationId: string,
  googleEventId: string,
  invoiceTotal: number,
): Promise<{ newAmountPaid: number; newRemainingBalance: number }> {
  const client = getSupabaseServerClient();

  const { error } = await client
    .from("payment_batch_allocations")
    .delete()
    .eq("id", allocationId);

  if (error) throw new Error(`[payments] delete-allocation failed: ${error.message}`);

  return recalcInvoicePayments(googleEventId, invoiceTotal);
}

/**
 * Recompute and persist amount_paid + remaining_balance + status on invoice_data
 * based on the current allocations. Called after any allocation change.
 */
// ---------------------------------------------------------------------------
// Pure calculation (exported for testing)
// ---------------------------------------------------------------------------

export type PaymentStatus = "sent" | "partially_paid" | "paid";

export interface PaymentCalcResult {
  amountPaid:       number;
  remainingBalance: number;
  status:           PaymentStatus;
  paidDate:         string | null; // YYYY-MM-DD when fully paid, else null
}

/**
 * Pure function — no I/O. Determines invoice payment status from allocation totals.
 * Exported so unit tests can verify it without hitting the database.
 *
 * @param totalAllocated  Sum of all payment_batch_allocations for this invoice.
 * @param invoiceTotal    The invoice's total due amount.
 * @param today           YYYY-MM-DD to stamp paid_date (injected so tests are deterministic).
 */
export function calcPaymentResult(
  totalAllocated: number,
  invoiceTotal:   number,
  today:          string,
): PaymentCalcResult {
  const amountPaid       = round2(Math.min(totalAllocated, invoiceTotal));
  const remainingBalance = round2(Math.max(0, invoiceTotal - totalAllocated));

  let status: PaymentStatus;
  if (totalAllocated <= 0)            status = "sent";
  else if (remainingBalance <= 0.005) status = "paid";
  else                                status = "partially_paid";

  return {
    amountPaid,
    remainingBalance,
    status,
    paidDate: status === "paid" ? today : null,
  };
}

export async function recalcInvoicePayments(
  googleEventId: string,
  invoiceTotal: number,
): Promise<{ newAmountPaid: number; newRemainingBalance: number }> {
  const client = getSupabaseServerClient();

  const { data: rows, error: sumError } = await client
    .from("payment_batch_allocations")
    .select("allocated_amount")
    .eq("google_event_id", googleEventId);

  if (sumError) throw new Error(`[payments] recalc-sum failed: ${sumError.message}`);

  const totalAllocated = round2(
    (rows ?? []).reduce((s, r) => s + Number((r as Record<string, unknown>).allocated_amount ?? 0), 0),
  );

  const today = new Date().toISOString().slice(0, 10);
  const calc  = calcPaymentResult(totalAllocated, invoiceTotal, today);

  const now = new Date().toISOString();
  const { error: updError } = await client
    .from("invoice_data")
    .update({
      amount_paid:       calc.amountPaid,
      remaining_balance: calc.remainingBalance,
      invoice_status:    calc.status,
      paid_date:         calc.paidDate,
      updated_at:        now,
    })
    .eq("google_event_id", googleEventId);

  if (updError) throw new Error(`[payments] recalc-update failed: ${updError.message}`);

  return { newAmountPaid: calc.amountPaid, newRemainingBalance: calc.remainingBalance };
}

/**
 * Returns payment batch metadata for the most recently created allocation on this
 * invoice. Used to populate the Google Sheet's payment columns after a recalc.
 * Returns empty strings when no allocations exist (e.g. after last allocation removed).
 */
export async function getLatestPaymentMeta(googleEventId: string): Promise<{
  paymentMethod:       string;
  paymentReceivedDate: string;
  paymentBatchRef:     string;
}> {
  const client = getSupabaseServerClient();
  const { data, error } = await client
    .from("payment_batch_allocations")
    .select("payment_batches(payment_method, received_date, reference)")
    .eq("google_event_id", googleEventId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`[payments] get-latest-payment-meta failed: ${error.message}`);
  if (!data) return { paymentMethod: "", paymentReceivedDate: "", paymentBatchRef: "" };

  const batch = (data as Record<string, unknown>).payment_batches as Record<string, unknown> | null;
  return {
    paymentMethod:       batch?.payment_method != null ? String(batch.payment_method)  : "",
    paymentReceivedDate: batch?.received_date  != null ? String(batch.received_date)   : "",
    paymentBatchRef:     batch?.reference      != null ? String(batch.reference)       : "",
  };
}

// ---------------------------------------------------------------------------
// Batch summary (for the payments list page)
// ---------------------------------------------------------------------------

export interface BatchSummary extends PaymentBatch {
  allocatedTotal: number;
  unallocatedTotal: number;
  allocationCount: number;
}

export async function listBatchesWithSummary(): Promise<BatchSummary[]> {
  const client = getSupabaseServerClient();
  const { data: batches, error: bErr } = await client
    .from("payment_batches")
    .select("*")
    .order("received_date", { ascending: false });

  if (bErr) throw new Error(`[payments] list-summary batches failed: ${bErr.message}`);

  const { data: allocs, error: aErr } = await client
    .from("payment_batch_allocations")
    .select("payment_batch_id, allocated_amount");

  if (aErr) throw new Error(`[payments] list-summary allocs failed: ${aErr.message}`);

  // Group allocations by batch
  const byBatch = new Map<string, number[]>();
  for (const a of allocs ?? []) {
    const r = a as Record<string, unknown>;
    const bid = String(r.payment_batch_id ?? "");
    if (!byBatch.has(bid)) byBatch.set(bid, []);
    byBatch.get(bid)!.push(Number(r.allocated_amount ?? 0));
  }

  return (batches ?? []).map((b) => {
    const row = coerceBatch(b as Record<string, unknown>);
    const amounts = byBatch.get(row.id) ?? [];
    const allocatedTotal = round2(amounts.reduce((s, n) => s + n, 0));
    return {
      ...row,
      allocatedTotal,
      unallocatedTotal: round2(Math.max(0, row.amount - allocatedTotal)),
      allocationCount:  amounts.length,
    };
  });
}
