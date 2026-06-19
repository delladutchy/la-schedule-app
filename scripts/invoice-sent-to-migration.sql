-- Track email recipients for sent invoices
-- Run this against your Supabase project to add the invoice_sent_to column.
--
-- How to run:
--   Option A — Supabase SQL Editor:
--     Open your project → SQL Editor → paste this file → Run
--   Option B — Supabase CLI:
--     supabase sql --file scripts/invoice-sent-to-migration.sql

ALTER TABLE invoice_data
  ADD COLUMN IF NOT EXISTS invoice_sent_to TEXT DEFAULT NULL;

COMMENT ON COLUMN invoice_data.invoice_sent_to IS
  'Comma-separated email recipients (To + CC) from the last invoice send.';
