-- Add optional receipt metadata columns to invoice_attachments.
-- These fields are used to populate the PDF appendix header and subtitle.
--   receipt_date     — the date on the receipt (defaults NULL; UI falls back to created_at)
--   receipt_category — short label set by the user (e.g. "Parking", "Hotel")
--   receipt_amount   — dollar amount of the receipt
ALTER TABLE invoice_attachments
  ADD COLUMN IF NOT EXISTS receipt_date     DATE,
  ADD COLUMN IF NOT EXISTS receipt_category TEXT,
  ADD COLUMN IF NOT EXISTS receipt_amount   NUMERIC(10, 2);
