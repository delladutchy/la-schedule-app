-- QuickBooks Online integration
-- Run this against your Supabase project before enabling QUICKBOOKS_ENABLED=true.
--
-- How to run:
--   Option A — Supabase SQL Editor:
--     Open your project → SQL Editor → paste this file → Run
--   Option B — Supabase CLI:
--     supabase db remote set "$SUPABASE_URL"
--     supabase sql --file scripts/qb-migration.sql

-- ── QB fields on invoice_data ─────────────────────────────────────────────────
-- Stores the QB invoice ID + link returned after creating a draft invoice.

ALTER TABLE invoice_data
  ADD COLUMN IF NOT EXISTS quickbooks_invoice_id    text,
  ADD COLUMN IF NOT EXISTS quickbooks_invoice_link  text,
  ADD COLUMN IF NOT EXISTS quickbooks_synced_at     timestamptz,
  ADD COLUMN IF NOT EXISTS quickbooks_sync_error    text;

-- ── quickbooks_setup ─────────────────────────────────────────────────────────
-- Caches the resolved QBO item IDs + customer ID from the bootstrap run.
-- One row per QB company (realm). Re-running bootstrap upserts this row.

CREATE TABLE IF NOT EXISTS quickbooks_setup (
  realm_id            text PRIMARY KEY,
  customer_id         text,
  customer_name       text,
  item_ids            jsonb,         -- { dayRate: "42", overtime: "43", ... }
  income_account_ref  jsonb,         -- { value: "79", name: "Services" }
  bootstrapped_at     timestamptz,
  bootstrap_error     text
);

-- Optional: fast lookup by QB invoice ID
CREATE INDEX IF NOT EXISTS idx_invoice_data_qb_invoice_id
  ON invoice_data (quickbooks_invoice_id)
  WHERE quickbooks_invoice_id IS NOT NULL;
