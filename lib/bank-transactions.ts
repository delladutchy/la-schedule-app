import "server-only";
import { getSupabaseServerClient } from "./supabase";
import { listInvoicesForPayments, getInvoiceData } from "./invoice-data";
import { getLatestPaymentMeta } from "./payment-batches";
import { updateSheetPaymentColumns } from "./google-sheets";
import {
  decideAutomaticReconciliation,
  dedupeBankTransactionImports,
  resolveLaPaySheetName,
  type BankTransactionImport,
  type ReconciliationDecision,
} from "./bank-reconciliation";

export interface StoredBankTransaction {
  id: string;
  source: string;
  external_transaction_id: string;
  posted_date: string;
  amount: number;
  description: string;
  source_account: string | null;
  raw_metadata: Record<string, unknown>;
  reconciliation_status: "pending" | "review" | "applied" | "reversed" | "ignored";
  reconciliation_details: Record<string, unknown>;
}

export interface BankImportResult {
  transaction: StoredBankTransaction;
  importStatus: "imported" | "duplicate";
  reconciliation?: ReconciliationDecision & { paymentBatchId?: string };
}

function coerceTransaction(row: Record<string, unknown>): StoredBankTransaction {
  return {
    id: String(row.id ?? ""),
    source: String(row.source ?? ""),
    external_transaction_id: String(row.external_transaction_id ?? ""),
    posted_date: String(row.posted_date ?? ""),
    amount: Number(row.amount ?? 0),
    description: String(row.description ?? ""),
    source_account: row.source_account != null ? String(row.source_account) : null,
    raw_metadata: (row.raw_metadata as Record<string, unknown> | null) ?? {},
    reconciliation_status: String(row.reconciliation_status ?? "pending") as StoredBankTransaction["reconciliation_status"],
    reconciliation_details: (row.reconciliation_details as Record<string, unknown> | null) ?? {},
  };
}

async function findStoredTransaction(source: string, externalId: string): Promise<StoredBankTransaction | null> {
  const db = getSupabaseServerClient();
  const { data, error } = await db.from("bank_transactions").select("*")
    .eq("source", source).eq("external_transaction_id", externalId).maybeSingle();
  if (error) throw new Error(`[bank] find transaction failed: ${error.message}`);
  return data ? coerceTransaction(data as Record<string, unknown>) : null;
}

export async function importBankTransactions(
  imports: BankTransactionImport[],
  options: { autoReconcile?: boolean; createdBy?: string } = {},
): Promise<BankImportResult[]> {
  const db = getSupabaseServerClient();
  const uniqueImports = dedupeBankTransactionImports(imports);
  const results: BankImportResult[] = [];

  for (const transaction of uniqueImports) {
    const { data, error } = await db.from("bank_transactions").insert({
      source: transaction.source,
      external_transaction_id: transaction.externalTransactionId,
      posted_date: transaction.postedDate,
      amount: transaction.amount,
      description: transaction.description,
      source_account: transaction.sourceAccount,
      raw_metadata: transaction.rawMetadata,
    }).select("*").single();

    if (error?.code === "23505") {
      const existing = await findStoredTransaction(transaction.source, transaction.externalTransactionId);
      if (!existing) throw new Error("[bank] duplicate transaction exists but could not be read");
      results.push({ transaction: existing, importStatus: "duplicate" });
      continue;
    }
    if (error) throw new Error(`[bank] import failed: ${error.message}`);
    const stored = coerceTransaction(data as Record<string, unknown>);
    const result: BankImportResult = { transaction: stored, importStatus: "imported" };
    if (options.autoReconcile !== false) {
      result.reconciliation = await reconcileBankTransaction(stored.id, options.createdBy);
      result.transaction = (await findStoredTransaction(stored.source, stored.external_transaction_id)) ?? stored;
    }
    results.push(result);
  }
  return results;
}

export async function reconcileBankTransaction(
  transactionId: string,
  createdBy = "automatic-bank-reconciliation",
): Promise<ReconciliationDecision & { paymentBatchId?: string }> {
  const db = getSupabaseServerClient();
  const { data: rawTransaction, error: transactionError } = await db
    .from("bank_transactions").select("*").eq("id", transactionId).single();
  if (transactionError) throw new Error(`[bank] load transaction failed: ${transactionError.message}`);
  const transaction = coerceTransaction(rawTransaction as Record<string, unknown>);
  if (transaction.reconciliation_status === "applied") {
    const paymentBatchId = typeof transaction.reconciliation_details.paymentBatchId === "string"
      ? transaction.reconciliation_details.paymentBatchId : undefined;
    return { action: "auto_apply", reason: "unique_exact_match", allocations: [], candidateMatches: [], paymentBatchId };
  }

  const invoices = await listInvoicesForPayments();
  const decision: ReconciliationDecision = transaction.amount > 0 && !/light\s*action/i.test(transaction.description)
    ? { action: "review", reason: "unrecognized_counterparty", allocations: [], candidateMatches: [] }
    : decideAutomaticReconciliation(transaction.amount, invoices);
  if (decision.action === "ignore") {
    const { error: ignoreError } = await db.from("bank_transactions").update({
      reconciliation_status: "ignored",
      reconciliation_details: { reason: decision.reason },
    }).eq("id", transaction.id);
    if (ignoreError) throw new Error(`[bank] transaction ignore status failed: ${ignoreError.message}`);
    return decision;
  }
  if (decision.action === "review") {
    const candidates = decision.candidateMatches;
    const { error: reviewError } = await db.from("bank_reconciliation_reviews").upsert({
      bank_transaction_id: transaction.id,
      reason: decision.reason,
      candidate_matches: candidates,
      review_status: "open",
      resolved_at: null,
      resolution_notes: null,
    }, { onConflict: "bank_transaction_id" });
    if (reviewError) throw new Error(`[bank] review queue write failed: ${reviewError.message}`);
    const { error: updateError } = await db.from("bank_transactions").update({
      reconciliation_status: "review",
      reconciliation_details: { reason: decision.reason, candidateMatches: candidates },
    }).eq("id", transaction.id);
    if (updateError) throw new Error(`[bank] transaction review status failed: ${updateError.message}`);
    return decision;
  }

  const { data: batchId, error: applyError } = await db.rpc("apply_bank_transaction_reconciliation", {
    p_bank_transaction_id: transaction.id,
    p_allocations: decision.allocations,
    p_created_by: createdBy,
  });
  if (applyError) throw new Error(`[bank] automatic apply failed: ${applyError.message}`);
  await Promise.all(decision.allocations.map((allocation) => syncInvoicePaymentToYearSheet(allocation.googleEventId)));
  return { ...decision, paymentBatchId: String(batchId ?? "") };
}

export async function reverseBankTransactionReconciliation(transactionId: string): Promise<string[]> {
  const db = getSupabaseServerClient();
  const { data, error } = await db.rpc("reverse_bank_transaction_reconciliation", {
    p_bank_transaction_id: transactionId,
  });
  if (error) throw new Error(`[bank] reversal failed: ${error.message}`);
  const eventIds = Array.isArray(data) ? data.map(String) : [];
  await Promise.all(eventIds.map(syncInvoicePaymentToYearSheet));
  return eventIds;
}

export async function listOpenBankReconciliationReviews(): Promise<Record<string, unknown>[]> {
  const db = getSupabaseServerClient();
  const { data, error } = await db.from("bank_reconciliation_reviews")
    .select("*, bank_transactions(*)").eq("review_status", "open").order("created_at");
  if (error) throw new Error(`[bank] list reviews failed: ${error.message}`);
  return (data ?? []) as Record<string, unknown>[];
}

async function syncInvoicePaymentToYearSheet(googleEventId: string): Promise<void> {
  const [invoice, paymentMeta] = await Promise.all([
    getInvoiceData(googleEventId),
    getLatestPaymentMeta(googleEventId),
  ]);
  if (!invoice || (!invoice.la_number && !invoice.invoice_number)) return;
  const sheetName = resolveLaPaySheetName(
    invoice.workday_entries.map((entry) => entry.date),
    process.env.GOOGLE_SHEET_NAME ?? "LA PAY (2026)",
  );
  await updateSheetPaymentColumns({
    laJobNumber: invoice.la_number ?? "",
    invoiceNumber: invoice.invoice_number ?? "",
    status: invoice.invoice_status,
    paidDate: invoice.paid_date ?? "",
    invoicePdfUrl: invoice.invoice_pdf_url ?? "",
    invoiceSentDate: invoice.invoice_sent_at?.slice(0, 10) ?? "",
    amountPaid: invoice.amount_paid,
    remainingBalance: invoice.remaining_balance ?? 0,
    paymentMethod: paymentMeta.paymentMethod,
    paymentReceivedDate: paymentMeta.paymentReceivedDate,
    paymentBatchRef: paymentMeta.paymentBatchRef,
  }, { sheetName });
}
