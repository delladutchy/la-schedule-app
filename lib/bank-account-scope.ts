import "server-only";
import { getSupabaseServerClient } from "./supabase";

/**
 * Whether a provider account may feed invoice reconciliation.
 *
 * Every connected account keeps importing and retaining transactions for
 * future tax/accounting analysis. Only accounts flagged `reconciliation_enabled`
 * are allowed to reach the matcher or create review items, so personal savings
 * sweeps, internal transfers, and card activity never clutter the queue.
 *
 * Fails open on purpose: a transaction with no provider attribution (manually
 * imported CSV/verified bank evidence) or an account we have no row for keeps
 * the previous behavior. Those still pass the Light Action counterparty gate
 * and cross-source duplicate protection, so failing open cannot create a
 * payment that the existing safeguards would have refused.
 */
export async function isAccountInReconciliationScope(
  providerAccountId: string | null,
): Promise<boolean> {
  if (!providerAccountId) return true;
  const db = getSupabaseServerClient();
  const { data, error } = await db
    .from("bank_provider_accounts")
    .select("reconciliation_enabled")
    .eq("provider_account_id", providerAccountId)
    .maybeSingle();
  if (error) {
    console.error(`[bank-scope] account scope lookup failed: ${error.message}`);
    return true;
  }
  if (!data) return true;
  return (data as { reconciliation_enabled: boolean | null }).reconciliation_enabled !== false;
}
