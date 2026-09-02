-- Future provider accounts fail closed for invoice reconciliation. Existing
-- Wells Fargo account 8155 remains the sole explicitly enabled account.
ALTER TABLE public.bank_provider_accounts
  ALTER COLUMN reconciliation_enabled SET DEFAULT false;

UPDATE public.bank_provider_accounts
SET reconciliation_enabled = (mask = '8155')
WHERE reconciliation_enabled IS DISTINCT FROM (mask = '8155');
