-- QuickBooks Online integration fields
-- Run this against the Supabase invoice_data table before enabling QUICKBOOKS_ENABLED=true.
--
-- How to run:
--   1. Open your Supabase project → SQL Editor
--   2. Paste this file and click Run
--   OR use the Supabase CLI:
--   supabase db remote set "$SUPABASE_URL" && supabase sql --file scripts/qb-migration.sql

ALTER TABLE invoice_data
  ADD COLUMN IF NOT EXISTS quickbooks_invoice_id    text,
  ADD COLUMN IF NOT EXISTS quickbooks_invoice_link  text,
  ADD COLUMN IF NOT EXISTS quickbooks_synced_at     timestamptz,
  ADD COLUMN IF NOT EXISTS quickbooks_sync_error    text;

-- Optional: index for fast lookups by QB invoice ID
CREATE INDEX IF NOT EXISTS idx_invoice_data_qb_invoice_id
  ON invoice_data (quickbooks_invoice_id)
  WHERE quickbooks_invoice_id IS NOT NULL;
