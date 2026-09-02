import "server-only";
import { listInvoicesForPayments } from "./invoice-data";
import { eligibleInvoicesForAutoReconciliation } from "./bank-reconciliation";
import { listPublicBankConnections } from "./plaid-bank-sync";
import { getSupabaseServerClient } from "./supabase";

function total(rows: Array<{ amount: unknown }>): number {
  return Math.round(rows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0) * 100) / 100;
}

export async function getBankReconciliationHealth() {
  const db = getSupabaseServerClient();
  const [connections, invoices, unappliedResult, reviewsResult] = await Promise.all([
    listPublicBankConnections(),
    listInvoicesForPayments(),
    db.from("bank_transactions").select("amount")
      .gt("amount", 0).in("reconciliation_status", ["pending", "review"]).ilike("description", "%light%action%"),
    db.from("bank_reconciliation_reviews").select("reason").eq("review_status", "open"),
  ]);
  if (unappliedResult.error) throw new Error(`[bank-health] unapplied query failed: ${unappliedResult.error.message}`);
  if (reviewsResult.error) throw new Error(`[bank-health] review query failed: ${reviewsResult.error.message}`);

  const unpaid = eligibleInvoicesForAutoReconciliation(invoices);
  const reviews = reviewsResult.data ?? [];
  const ambiguous = reviews.filter((row) => ["ambiguous_exact_match", "ambiguous_cross_source_overlap"].includes(row.reason));
  const providerChanges = reviews.filter((row) => ["provider_modified_applied_transaction", "provider_removed_applied_transaction"].includes(row.reason));
  const active = connections.filter((connection) => connection.connection_status !== "disconnected");
  const syncErrors = active.filter((connection) => connection.last_error_code);
  const lastSync = active.map((connection) => connection.last_successful_sync_at).filter(Boolean).sort().at(-1) ?? null;
  return {
    connection: {
      connected: active.length > 0,
      healthy: active.some((connection) => connection.connection_status === "healthy"),
      reconnectRequired: active.some((connection) => connection.connection_status === "relogin_required"),
      lastSuccessfulSyncAt: lastSync,
    },
    unappliedLightActionDeposits: { count: unappliedResult.data?.length ?? 0, value: total(unappliedResult.data ?? []) },
    ambiguousReviews: { count: ambiguous.length },
    appliedProviderChanges: { count: providerChanges.length },
    syncErrors: { count: syncErrors.length, codes: [...new Set(syncErrors.map((connection) => connection.last_error_code).filter(Boolean))] },
    unpaidInvoices: {
      count: unpaid.length,
      value: Math.round(unpaid.reduce((sum, invoice) => sum + Number(invoice.remaining_balance ?? invoice.invoice_total ?? 0), 0) * 100) / 100,
    },
    interventionRequired: active.some((connection) => ["degraded", "relogin_required"].includes(connection.connection_status))
      || (unappliedResult.data?.length ?? 0) > 0 || reviews.length > 0,
  };
}
