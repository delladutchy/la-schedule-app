import "server-only";
import { getSupabaseServerClient } from "./supabase";
import {
  decideCrossSourceOverlap,
  type CrossSourceOverlapDecision,
  type CrossSourceOverlapInput,
  type ExistingBankPaymentEvidence,
  type ExistingPaymentBatchEvidence,
  type PaidInvoiceEvidence,
} from "./bank-overlap";

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Loads only the narrow, exact-amount/date evidence needed by the pure overlap decision. */
export async function findCrossSourceOverlap(input: CrossSourceOverlapInput): Promise<CrossSourceOverlapDecision> {
  const db = getSupabaseServerClient();
  const from = shiftDate(input.postedDate, -2);
  const to = shiftDate(input.postedDate, 2);

  const [bankResult, batchResult, invoiceResult] = await Promise.all([
    db.from("bank_transactions")
      .select("id, source, posted_date, amount, description, source_account, linked_payment_batch_id")
      .neq("source", input.source).eq("amount", input.amount).gte("posted_date", from).lte("posted_date", to)
      .in("reconciliation_status", ["applied", "duplicate"]),
    db.from("payment_batches")
      .select("id, received_date, amount, bank_account, reference, bank_transaction_id, payment_batch_allocations(id, google_event_id)")
      .eq("client_name", "Light Action").eq("amount", input.amount).gte("received_date", from).lte("received_date", to),
    db.from("invoice_data")
      .select("google_event_id, invoice_number, paid_date, amount_paid, client, invoice_status")
      .eq("client", "Light Action").eq("invoice_status", "paid").not("paid_date", "is", null)
      .gte("paid_date", from).lte("paid_date", to),
  ]);
  if (bankResult.error) throw new Error(`[bank] overlap bank evidence failed: ${bankResult.error.message}`);
  if (batchResult.error) throw new Error(`[bank] overlap batch evidence failed: ${batchResult.error.message}`);
  if (invoiceResult.error) throw new Error(`[bank] overlap invoice evidence failed: ${invoiceResult.error.message}`);

  const bankTransactions: ExistingBankPaymentEvidence[] = (bankResult.data ?? []).map((row) => {
    const joined = (batchResult.data ?? []).find((batch) => (
      String(batch.bank_transaction_id ?? "") === String(row.id)
      || String(batch.id) === String(row.linked_payment_batch_id ?? "")
    ));
    const allocations = joined && Array.isArray(joined.payment_batch_allocations) ? joined.payment_batch_allocations : [];
    return {
      bankTransactionId: String(row.id), source: String(row.source), postedDate: String(row.posted_date),
      amount: Number(row.amount), description: String(row.description), sourceAccount: row.source_account,
      paymentBatchId: joined?.id ? String(joined.id) : row.linked_payment_batch_id ? String(row.linked_payment_batch_id) : null,
      paymentReference: joined?.reference ? String(joined.reference) : null,
      allocationIds: allocations.map((allocation) => String(allocation.id)),
      invoiceEventIds: allocations.map((allocation) => String(allocation.google_event_id)),
    };
  });
  const paymentBatches: ExistingPaymentBatchEvidence[] = (batchResult.data ?? []).map((row) => {
    const allocations = Array.isArray(row.payment_batch_allocations) ? row.payment_batch_allocations : [];
    return {
      paymentBatchId: String(row.id), receivedDate: String(row.received_date), amount: Number(row.amount),
      bankAccount: row.bank_account, reference: row.reference, bankTransactionId: row.bank_transaction_id,
      allocationIds: allocations.map((allocation) => String(allocation.id)),
      invoiceEventIds: allocations.map((allocation) => String(allocation.google_event_id)),
    };
  });
  const paidInvoices: PaidInvoiceEvidence[] = (invoiceResult.data ?? []).map((row) => ({
    googleEventId: String(row.google_event_id), invoiceNumber: row.invoice_number,
    paidDate: String(row.paid_date), amountPaid: Number(row.amount_paid),
  }));
  return decideCrossSourceOverlap(input, { bankTransactions, paymentBatches, paidInvoices });
}
