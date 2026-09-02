-- Restrict automatic invoice reconciliation to specific bank accounts while
-- continuing to import and retain every connected account's history.
--
-- Sharing all four Wells Fargo accounts is useful for future tax/accounting
-- analysis, but only the checking account that actually receives Light Action
-- payroll should feed invoice reconciliation. Personal savings sweeps, internal
-- transfers, and card activity were otherwise filling the review queue.
--
-- Additive: adds one column with a safe default. No DML against invoices,
-- payment batches, allocations, or bank transactions.

ALTER TABLE public.bank_provider_accounts
  ADD COLUMN IF NOT EXISTS reconciliation_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN public.bank_provider_accounts.reconciliation_enabled IS
  'When false, this account''s transactions are still imported and retained, but never feed invoice reconciliation or the review queue.';

-- bank_transactions.provider_account_id joins to this column.
CREATE INDEX IF NOT EXISTS idx_bank_provider_accounts_provider_account_id
  ON public.bank_provider_accounts (provider_account_id);
