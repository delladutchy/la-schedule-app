-- Phase 3: conservative cross-source overlap protection, complete payment
-- provenance, recovery-poll telemetry, and replay-safe Plaid webhooks.

ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS provider_account_id TEXT,
  ADD COLUMN IF NOT EXISTS duplicate_of_bank_transaction_id UUID
    REFERENCES public.bank_transactions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS linked_payment_batch_id UUID
    REFERENCES public.payment_batches(id) ON DELETE RESTRICT;

ALTER TABLE public.bank_transactions
  DROP CONSTRAINT IF EXISTS bank_transactions_reconciliation_status_check;
ALTER TABLE public.bank_transactions
  ADD CONSTRAINT bank_transactions_reconciliation_status_check
  CHECK (reconciliation_status IN ('pending', 'review', 'applied', 'duplicate', 'reversed', 'ignored'));
ALTER TABLE public.bank_transactions
  DROP CONSTRAINT IF EXISTS bank_transactions_not_self_duplicate;
ALTER TABLE public.bank_transactions
  ADD CONSTRAINT bank_transactions_not_self_duplicate
  CHECK (duplicate_of_bank_transaction_id IS NULL OR duplicate_of_bank_transaction_id <> id);

CREATE INDEX IF NOT EXISTS idx_bank_transactions_overlap_lookup
  ON public.bank_transactions (posted_date, amount)
  WHERE amount > 0;
CREATE INDEX IF NOT EXISTS idx_bank_transactions_duplicate_of
  ON public.bank_transactions (duplicate_of_bank_transaction_id)
  WHERE duplicate_of_bank_transaction_id IS NOT NULL;

ALTER TABLE public.bank_provider_connections
  ADD COLUMN IF NOT EXISTS last_recovery_poll_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_cursor_advanced_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.bank_provider_webhook_receipts (
  signature_hash       TEXT PRIMARY KEY,
  provider             TEXT NOT NULL CHECK (provider IN ('plaid')),
  provider_item_id     TEXT,
  webhook_type         TEXT,
  webhook_code         TEXT,
  processing_status    TEXT NOT NULL DEFAULT 'processing'
    CHECK (processing_status IN ('processing', 'completed', 'failed')),
  attempt_count        INTEGER NOT NULL DEFAULT 1,
  received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at         TIMESTAMPTZ,
  last_error           TEXT
);

ALTER TABLE public.bank_provider_webhook_receipts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_full_access" ON public.bank_provider_webhook_receipts;
CREATE POLICY "service_role_full_access"
  ON public.bank_provider_webhook_receipts FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.claim_bank_provider_webhook(
  p_signature_hash TEXT,
  p_provider_item_id TEXT,
  p_webhook_type TEXT,
  p_webhook_code TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_claimed TEXT;
BEGIN
  INSERT INTO public.bank_provider_webhook_receipts (
    signature_hash, provider, provider_item_id, webhook_type, webhook_code
  ) VALUES (
    p_signature_hash, 'plaid', p_provider_item_id, p_webhook_type, p_webhook_code
  )
  ON CONFLICT (signature_hash) DO UPDATE
  SET processing_status = 'processing',
      attempt_count = bank_provider_webhook_receipts.attempt_count + 1,
      last_attempt_at = now(),
      last_error = NULL
  WHERE bank_provider_webhook_receipts.processing_status = 'failed'
     OR (bank_provider_webhook_receipts.processing_status = 'processing'
         AND bank_provider_webhook_receipts.last_attempt_at < now() - interval '10 minutes')
  RETURNING signature_hash INTO v_claimed;
  RETURN v_claimed IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_bank_transaction_duplicate(
  p_bank_transaction_id UUID,
  p_duplicate_of_bank_transaction_id UUID,
  p_linked_payment_batch_id UUID,
  p_details JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_transaction public.bank_transactions%ROWTYPE;
BEGIN
  SELECT * INTO v_transaction
  FROM public.bank_transactions
  WHERE id = p_bank_transaction_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank transaction % not found', p_bank_transaction_id; END IF;
  IF v_transaction.reconciliation_status = 'applied' THEN
    RAISE EXCEPTION 'Applied bank transaction % cannot be converted to a duplicate', p_bank_transaction_id;
  END IF;

  UPDATE public.bank_transactions
  SET reconciliation_status = 'duplicate',
      duplicate_of_bank_transaction_id = p_duplicate_of_bank_transaction_id,
      linked_payment_batch_id = p_linked_payment_batch_id,
      reconciliation_details = p_details,
      reconciled_at = now(),
      reversed_at = NULL
  WHERE id = p_bank_transaction_id;

  UPDATE public.bank_reconciliation_reviews
  SET review_status = 'resolved', resolved_at = now(),
      resolution_notes = 'Linked as cross-source provenance for an existing payment.'
  WHERE bank_transaction_id = p_bank_transaction_id AND review_status = 'open';
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.advance_bank_provider_sync(
  p_connection_id UUID,
  p_lock_token UUID,
  p_cursor TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated UUID;
BEGIN
  UPDATE public.bank_provider_connections
  SET sync_cursor = p_cursor,
      last_cursor_advanced_at = now(),
      sync_lock_until = now() + interval '600 seconds'
  WHERE id = p_connection_id AND sync_lock_token = p_lock_token
  RETURNING id INTO v_updated;
  RETURN v_updated IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_bank_transaction_reconciliation(
  p_bank_transaction_id UUID,
  p_allocations JSONB,
  p_created_by TEXT DEFAULT 'automatic-bank-reconciliation'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_transaction public.bank_transactions%ROWTYPE;
  v_batch_id UUID;
  v_allocation JSONB;
  v_allocation_id UUID;
  v_allocation_ids UUID[] := ARRAY[]::UUID[];
  v_event_id TEXT;
  v_amount NUMERIC(12,2);
  v_allocation_total NUMERIC(12,2);
  v_invoice public.invoice_data%ROWTYPE;
  v_balance NUMERIC(12,2);
BEGIN
  SELECT * INTO v_transaction FROM public.bank_transactions
  WHERE id = p_bank_transaction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank transaction % not found', p_bank_transaction_id; END IF;
  IF v_transaction.reconciliation_status = 'applied' THEN
    SELECT id INTO v_batch_id FROM public.payment_batches WHERE bank_transaction_id = p_bank_transaction_id;
    IF v_batch_id IS NULL THEN RAISE EXCEPTION 'Applied transaction % has no payment batch', p_bank_transaction_id; END IF;
    RETURN v_batch_id;
  END IF;
  IF v_transaction.reconciliation_status = 'duplicate' THEN
    RAISE EXCEPTION 'Duplicate transaction % cannot create a payment', p_bank_transaction_id;
  END IF;
  IF v_transaction.amount <= 0 THEN RAISE EXCEPTION 'Only positive deposits can auto-apply'; END IF;
  IF jsonb_typeof(p_allocations) <> 'array' OR jsonb_array_length(p_allocations) = 0 THEN
    RAISE EXCEPTION 'At least one allocation is required';
  END IF;

  SELECT COALESCE(SUM((entry->>'amount')::NUMERIC), 0)
  INTO v_allocation_total FROM jsonb_array_elements(p_allocations) entry;
  IF ROUND(v_allocation_total, 2) <> v_transaction.amount THEN
    RAISE EXCEPTION 'Allocation total % does not equal bank amount %', v_allocation_total, v_transaction.amount;
  END IF;

  FOR v_allocation IN SELECT value FROM jsonb_array_elements(p_allocations)
  LOOP
    v_event_id := v_allocation->>'googleEventId';
    v_amount := ROUND((v_allocation->>'amount')::NUMERIC, 2);
    SELECT * INTO v_invoice FROM public.invoice_data WHERE google_event_id = v_event_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice event % not found', v_event_id; END IF;
    IF v_invoice.invoice_status IN ('paid', 'void') THEN
      RAISE EXCEPTION 'Invoice % is not eligible (% status)', v_invoice.invoice_number, v_invoice.invoice_status;
    END IF;
    v_balance := COALESCE(v_invoice.remaining_balance, GREATEST(0, v_invoice.invoice_total - v_invoice.amount_paid));
    IF ROUND(v_balance, 2) <> v_amount THEN
      RAISE EXCEPTION 'Invoice % balance % does not equal allocation %', v_invoice.invoice_number, v_balance, v_amount;
    END IF;
  END LOOP;

  INSERT INTO public.payment_batches (
    client_name, received_date, amount, payment_method, bank_account,
    reference, notes, created_by, bank_transaction_id
  ) VALUES (
    'Light Action', v_transaction.posted_date, v_transaction.amount, 'Direct Deposit',
    v_transaction.source_account,
    v_transaction.source || ':' || v_transaction.external_transaction_id,
    'Automatically reconciled from bank transaction: ' || v_transaction.description,
    p_created_by, v_transaction.id
  ) RETURNING id INTO v_batch_id;

  FOR v_allocation IN SELECT value FROM jsonb_array_elements(p_allocations)
  LOOP
    v_event_id := v_allocation->>'googleEventId';
    v_amount := ROUND((v_allocation->>'amount')::NUMERIC, 2);
    INSERT INTO public.payment_batch_allocations (
      payment_batch_id, google_event_id, allocated_amount, bank_transaction_id
    ) VALUES (v_batch_id, v_event_id, v_amount, v_transaction.id)
    RETURNING id INTO v_allocation_id;
    v_allocation_ids := array_append(v_allocation_ids, v_allocation_id);
  END LOOP;

  FOR v_event_id IN SELECT DISTINCT value->>'googleEventId' FROM jsonb_array_elements(p_allocations)
  LOOP
    PERFORM public.recalculate_invoice_payment_from_allocations(v_event_id);
  END LOOP;

  UPDATE public.bank_transactions
  SET reconciliation_status = 'applied',
      linked_payment_batch_id = v_batch_id,
      reconciliation_details = jsonb_build_object(
        'allocations', p_allocations,
        'allocationIds', to_jsonb(v_allocation_ids),
        'paymentBatchId', v_batch_id,
        'source', v_transaction.source,
        'postedDate', v_transaction.posted_date,
        'amount', v_transaction.amount,
        'description', v_transaction.description
      ),
      reconciled_at = now(), reversed_at = NULL
  WHERE id = v_transaction.id;

  UPDATE public.bank_reconciliation_reviews
  SET review_status = 'resolved', resolved_at = now(),
      resolution_notes = 'Applied after an exact reviewed or automatic match.'
  WHERE bank_transaction_id = v_transaction.id AND review_status = 'open';
  RETURN v_batch_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_bank_provider_webhook(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mark_bank_transaction_duplicate(UUID, UUID, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_bank_provider_webhook(TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_bank_transaction_duplicate(UUID, UUID, UUID, JSONB) TO service_role;
