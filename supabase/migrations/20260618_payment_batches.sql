-- Payment batch reconciliation.
-- Tracks lump direct-deposit payments from Light Action and allocates them
-- across one or more invoices.
-- Amounts stored as NUMERIC(10,2) for consistency with invoice_data.
-- Idempotent (safe to re-run).

-- ── payment_batches ───────────────────────────────────────────────────────────
-- One row per deposit received (e.g. a single bank transfer from Light Action).

CREATE TABLE IF NOT EXISTS payment_batches (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  client_name      TEXT         NOT NULL DEFAULT 'Light Action',
  received_date    DATE         NOT NULL,
  amount           NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  payment_method   TEXT         NOT NULL DEFAULT 'Direct Deposit',
  bank_account     TEXT,
  reference        TEXT,   -- bank memo / check number / wire ID
  notes            TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by       TEXT         -- editor ID for audit trail
);

ALTER TABLE payment_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access"
  ON payment_batches
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION update_payment_batches_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'payment_batches_updated_at'
  ) THEN
    CREATE TRIGGER payment_batches_updated_at
      BEFORE UPDATE ON payment_batches
      FOR EACH ROW EXECUTE FUNCTION update_payment_batches_updated_at();
  END IF;
END $$;

-- ── payment_batch_allocations ─────────────────────────────────────────────────
-- One row per invoice allocated from a batch.
-- Multiple rows can link one batch → many invoices, or many batches → one invoice.

CREATE TABLE IF NOT EXISTS payment_batch_allocations (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_batch_id    UUID         NOT NULL REFERENCES payment_batches(id) ON DELETE CASCADE,
  google_event_id     TEXT         NOT NULL,  -- FK to invoice_data.google_event_id
  allocated_amount    NUMERIC(10,2) NOT NULL CHECK (allocated_amount > 0),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE payment_batch_allocations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access"
  ON payment_batch_allocations
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_allocations_batch_id
  ON payment_batch_allocations (payment_batch_id);

CREATE INDEX IF NOT EXISTS idx_allocations_event_id
  ON payment_batch_allocations (google_event_id);
