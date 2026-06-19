-- Add invoice_sent_subject column to invoice_data table.
-- Run once in Supabase SQL Editor. Safe to re-run (ADD COLUMN IF NOT EXISTS).
--
-- Stores the email subject from the most recent invoice send.
-- Example: "Jeff Ulsh - Invoice LA #5555"

ALTER TABLE invoice_data
  ADD COLUMN IF NOT EXISTS invoice_sent_subject TEXT DEFAULT NULL;

COMMENT ON COLUMN invoice_data.invoice_sent_subject IS
  'Email subject from the most recent invoice send (e.g. "Jeff Ulsh - Invoice LA #5555").';
