-- QuickBooks Online integration
-- Run this against your Supabase project before using QuickBooks features.
--
-- How to run:
--   Option A — Supabase SQL Editor:
--     Open your project → SQL Editor → paste this file → Run
--   Option B — Supabase CLI:
--     supabase db remote set "$SUPABASE_URL"
--     supabase sql --file scripts/qb-migration.sql
--
-- This file is idempotent (safe to re-run).

-- ── QB fields on invoice_data ─────────────────────────────────────────────────
-- Stores the QB invoice ID + link returned after creating a draft invoice.

ALTER TABLE invoice_data
  ADD COLUMN IF NOT EXISTS quickbooks_invoice_id    text,
  ADD COLUMN IF NOT EXISTS quickbooks_invoice_link  text,
  ADD COLUMN IF NOT EXISTS quickbooks_synced_at     timestamptz,
  ADD COLUMN IF NOT EXISTS quickbooks_sync_error    text;

CREATE INDEX IF NOT EXISTS idx_invoice_data_qb_invoice_id
  ON invoice_data (quickbooks_invoice_id)
  WHERE quickbooks_invoice_id IS NOT NULL;

-- ── quickbooks_connection ─────────────────────────────────────────────────────
-- Stores the OAuth refresh token and realm ID after the Connect to QuickBooks
-- flow completes. One singleton row (id = 1).
--
-- Credentials are stored server-side only — never sent to the browser.

CREATE TABLE IF NOT EXISTS quickbooks_connection (
  id                        int PRIMARY KEY DEFAULT 1,
  realm_id                  text NOT NULL,
  refresh_token             text NOT NULL,
  refresh_token_expires_at  timestamptz,
  connected_at              timestamptz DEFAULT now(),
  connected_by              text            -- editor ID for audit trail
);

-- ── quickbooks_oauth_state ────────────────────────────────────────────────────
-- Short-lived CSRF state tokens used during the OAuth flow.
-- Created by /api/quickbooks/connect, consumed by /api/quickbooks/callback.
-- Rows are one-time use and expire after 10 minutes.

CREATE TABLE IF NOT EXISTS quickbooks_oauth_state (
  state       text PRIMARY KEY,
  editor_id   text NOT NULL,
  created_at  timestamptz DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_qb_oauth_state_expires_at
  ON quickbooks_oauth_state (expires_at);

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
