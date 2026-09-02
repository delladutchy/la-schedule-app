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
 * Manual CSV/verified evidence has no provider account id and keeps the prior
 * behavior. Provider-attributed transactions fail closed when their account
 * row is missing or cannot be read: an unknown bank account must never reach
 * invoice matching.
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
    return false;
  }
  if (!data) return false;
  return (data as { reconciliation_enabled: boolean | null }).reconciliation_enabled === true;
}
