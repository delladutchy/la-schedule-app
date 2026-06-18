-- Native invoicing: PDF tracking, status expansion, and payment fields on invoice_data.
-- Run AFTER 20260617_invoice_data.sql and scripts/qb-migration.sql.
-- Idempotent (safe to re-run).

-- ── Invoice PDF / lifecycle fields ────────────────────────────────────────────

ALTER TABLE invoice_data
  ADD COLUMN IF NOT EXISTS invoice_number      TEXT,
  ADD COLUMN IF NOT EXISTS invoice_pdf_url     TEXT,
  ADD COLUMN IF NOT EXISTS invoice_created_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS invoice_sent_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS invoice_total       NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS amount_paid         NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS remaining_balance   NUMERIC(10,2);

-- Unique index prevents accidentally generating two different invoice numbers
-- for the same job (the upsert will just keep the existing one).
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_data_invoice_number
  ON invoice_data (invoice_number)
  WHERE invoice_number IS NOT NULL;

-- Quick lookup by status for the payments page.
CREATE INDEX IF NOT EXISTS idx_invoice_data_invoice_status
  ON invoice_data (invoice_status);
