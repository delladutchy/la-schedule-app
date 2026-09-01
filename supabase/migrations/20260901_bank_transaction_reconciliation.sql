-- Provider-independent bank transaction ingestion and automatic invoice reconciliation.
-- Keeps the existing payment_batches/payment_batch_allocations model as the accounting ledger.

CREATE TABLE IF NOT EXISTS public.bank_transactions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source                   TEXT NOT NULL,
  external_transaction_id  TEXT NOT NULL,
  posted_date              DATE NOT NULL,
  amount                   NUMERIC(12,2) NOT NULL CHECK (amount <> 0),
  description              TEXT NOT NULL DEFAULT '',
  source_account           TEXT,
  raw_metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
  reconciliation_status    TEXT NOT NULL DEFAULT 'pending'
    CHECK (reconciliation_status IN ('pending', 'review', 'applied', 'reversed', 'ignored')),
  reconciliation_details   JSONB NOT NULL DEFAULT '{}'::jsonb,
  imported_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  reconciled_at            TIMESTAMPTZ,
  reversed_at              TIMESTAMPTZ,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_transaction_id)
);

ALTER TABLE public.bank_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_full_access" ON public.bank_transactions;
CREATE POLICY "service_role_full_access"
  ON public.bank_transactions FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS public.bank_reconciliation_reviews (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_transaction_id   UUID NOT NULL UNIQUE REFERENCES public.bank_transactions(id) ON DELETE CASCADE,
  reason                TEXT NOT NULL,
  candidate_matches     JSONB NOT NULL DEFAULT '[]'::jsonb,
  review_status         TEXT NOT NULL DEFAULT 'open'
    CHECK (review_status IN ('open', 'resolved', 'dismissed')),
  resolution_notes      TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at           TIMESTAMPTZ
);

ALTER TABLE public.bank_reconciliation_reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_full_access" ON public.bank_reconciliation_reviews;
CREATE POLICY "service_role_full_access"
  ON public.bank_reconciliation_reviews FOR ALL TO service_role
  USING (true) WITH CHECK (true);

ALTER TABLE public.payment_batches
  ADD COLUMN IF NOT EXISTS bank_transaction_id UUID REFERENCES public.bank_transactions(id) ON DELETE RESTRICT;

ALTER TABLE public.payment_batch_allocations
  ADD COLUMN IF NOT EXISTS bank_transaction_id UUID REFERENCES public.bank_transactions(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_batches_bank_transaction
  ON public.payment_batches (bank_transaction_id)
  WHERE bank_transaction_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_allocations_batch_invoice
  ON public.payment_batch_allocations (payment_batch_id, google_event_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_allocations_bank_transaction_invoice
  ON public.payment_batch_allocations (bank_transaction_id, google_event_id)
  WHERE bank_transaction_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.update_bank_reconciliation_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bank_transactions_updated_at ON public.bank_transactions;
CREATE TRIGGER bank_transactions_updated_at
  BEFORE UPDATE ON public.bank_transactions
  FOR EACH ROW EXECUTE FUNCTION public.update_bank_reconciliation_updated_at();

DROP TRIGGER IF EXISTS bank_reconciliation_reviews_updated_at ON public.bank_reconciliation_reviews;
CREATE TRIGGER bank_reconciliation_reviews_updated_at
  BEFORE UPDATE ON public.bank_reconciliation_reviews
  FOR EACH ROW EXECUTE FUNCTION public.update_bank_reconciliation_updated_at();

CREATE OR REPLACE FUNCTION public.recalculate_invoice_payment_from_allocations(p_google_event_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice_total NUMERIC(10,2);
  v_total_allocated NUMERIC(12,2);
  v_paid_date DATE;
  v_remaining NUMERIC(12,2);
BEGIN
  SELECT invoice_total INTO v_invoice_total
  FROM public.invoice_data
  WHERE google_event_id = p_google_event_id
  FOR UPDATE;

  IF v_invoice_total IS NULL THEN
    RAISE EXCEPTION 'Invoice % has no invoice_total', p_google_event_id;
  END IF;

  SELECT
    COALESCE(SUM(a.allocated_amount), 0),
    MAX(b.received_date)
  INTO v_total_allocated, v_paid_date
  FROM public.payment_batch_allocations a
  JOIN public.payment_batches b ON b.id = a.payment_batch_id
  WHERE a.google_event_id = p_google_event_id;

  v_remaining := GREATEST(0, v_invoice_total - v_total_allocated);
  UPDATE public.invoice_data
  SET
    amount_paid = LEAST(v_invoice_total, v_total_allocated),
    remaining_balance = v_remaining,
    invoice_status = CASE
      WHEN v_total_allocated <= 0 THEN 'sent'
      WHEN v_remaining <= 0.005 THEN 'paid'
      ELSE 'partially_paid'
    END,
    paid_date = CASE WHEN v_remaining <= 0.005 AND v_total_allocated > 0 THEN v_paid_date ELSE NULL END,
    updated_at = now()
  WHERE google_event_id = p_google_event_id;
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
  v_event_id TEXT;
  v_amount NUMERIC(12,2);
  v_allocation_total NUMERIC(12,2);
  v_invoice public.invoice_data%ROWTYPE;
  v_balance NUMERIC(12,2);
BEGIN
  SELECT * INTO v_transaction
  FROM public.bank_transactions
  WHERE id = p_bank_transaction_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Bank transaction % not found', p_bank_transaction_id; END IF;
  IF v_transaction.reconciliation_status = 'applied' THEN
    SELECT id INTO v_batch_id FROM public.payment_batches WHERE bank_transaction_id = p_bank_transaction_id;
    IF v_batch_id IS NULL THEN RAISE EXCEPTION 'Applied transaction % has no payment batch', p_bank_transaction_id; END IF;
    RETURN v_batch_id;
  END IF;
  IF v_transaction.amount <= 0 THEN RAISE EXCEPTION 'Only positive deposits can auto-apply'; END IF;
  IF jsonb_typeof(p_allocations) <> 'array' OR jsonb_array_length(p_allocations) = 0 THEN
    RAISE EXCEPTION 'At least one allocation is required';
  END IF;

  SELECT COALESCE(SUM((entry->>'amount')::NUMERIC), 0)
  INTO v_allocation_total
  FROM jsonb_array_elements(p_allocations) entry;
  IF ROUND(v_allocation_total, 2) <> v_transaction.amount THEN
    RAISE EXCEPTION 'Allocation total % does not equal bank amount %', v_allocation_total, v_transaction.amount;
  END IF;

  -- Validate and lock every invoice before creating any accounting rows.
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
  )
  RETURNING id INTO v_batch_id;

  FOR v_allocation IN SELECT value FROM jsonb_array_elements(p_allocations)
  LOOP
    v_event_id := v_allocation->>'googleEventId';
    v_amount := ROUND((v_allocation->>'amount')::NUMERIC, 2);
    INSERT INTO public.payment_batch_allocations (
      payment_batch_id, google_event_id, allocated_amount, bank_transaction_id
    ) VALUES (v_batch_id, v_event_id, v_amount, v_transaction.id);
  END LOOP;

  FOR v_event_id IN
    SELECT DISTINCT value->>'googleEventId' FROM jsonb_array_elements(p_allocations)
  LOOP
    PERFORM public.recalculate_invoice_payment_from_allocations(v_event_id);
  END LOOP;

  UPDATE public.bank_transactions
  SET reconciliation_status = 'applied',
      reconciliation_details = jsonb_build_object('allocations', p_allocations, 'paymentBatchId', v_batch_id),
      reconciled_at = now(), reversed_at = NULL
  WHERE id = v_transaction.id;

  UPDATE public.bank_reconciliation_reviews
  SET review_status = 'resolved', resolved_at = now(), resolution_notes = 'Automatically applied after unique exact match.'
  WHERE bank_transaction_id = v_transaction.id AND review_status = 'open';

  RETURN v_batch_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.reverse_bank_transaction_reconciliation(p_bank_transaction_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_transaction public.bank_transactions%ROWTYPE;
  v_event_ids TEXT[];
  v_event_id TEXT;
BEGIN
  SELECT * INTO v_transaction
  FROM public.bank_transactions
  WHERE id = p_bank_transaction_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank transaction % not found', p_bank_transaction_id; END IF;
  IF v_transaction.reconciliation_status = 'reversed' THEN
    RETURN COALESCE(v_transaction.reconciliation_details->'reversedEventIds', '[]'::jsonb);
  END IF;
  IF v_transaction.reconciliation_status <> 'applied' THEN
    RAISE EXCEPTION 'Bank transaction % is not applied', p_bank_transaction_id;
  END IF;

  SELECT ARRAY_AGG(DISTINCT google_event_id) INTO v_event_ids
  FROM public.payment_batch_allocations
  WHERE bank_transaction_id = p_bank_transaction_id;

  DELETE FROM public.payment_batches WHERE bank_transaction_id = p_bank_transaction_id;

  FOREACH v_event_id IN ARRAY COALESCE(v_event_ids, ARRAY[]::TEXT[])
  LOOP
    PERFORM public.recalculate_invoice_payment_from_allocations(v_event_id);
  END LOOP;

  UPDATE public.bank_transactions
  SET reconciliation_status = 'reversed', reversed_at = now(),
      reconciliation_details = reconciliation_details || jsonb_build_object(
        'reversedEventIds', to_jsonb(COALESCE(v_event_ids, ARRAY[]::TEXT[]))
      )
  WHERE id = p_bank_transaction_id;

  RETURN to_jsonb(COALESCE(v_event_ids, ARRAY[]::TEXT[]));
END;
$$;

REVOKE ALL ON FUNCTION public.apply_bank_transaction_reconciliation(UUID, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reverse_bank_transaction_reconciliation(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recalculate_invoice_payment_from_allocations(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_bank_transaction_reconciliation(UUID, JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.reverse_bank_transaction_reconciliation(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.recalculate_invoice_payment_from_allocations(TEXT) TO service_role;
