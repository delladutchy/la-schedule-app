-- Add invoice text override columns to invoice_data table.
-- Run once in Supabase SQL Editor. Safe to re-run (ADD COLUMN IF NOT EXISTS).
--
-- These columns store optional user-edited overrides for PDF/email text.
-- Null = use auto-generated value. Non-null = use this instead.

ALTER TABLE invoice_data
  ADD COLUMN IF NOT EXISTS invoice_job_name_override TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS invoice_day_rate_description_override TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS invoice_note_override TEXT DEFAULT NULL;

COMMENT ON COLUMN invoice_data.invoice_job_name_override IS
  'Optional override for the job name shown on PDF, email body, and attachment filename. Null = use cleaned calendar title.';
COMMENT ON COLUMN invoice_data.invoice_day_rate_description_override IS
  'Optional override for the Day Rate description column in the PDF. Null = use auto-generated date/time lines.';
COMMENT ON COLUMN invoice_data.invoice_note_override IS
  'Optional override for the "Note to customer" section in the PDF. Null = use default "Thanks again, Jeff".';
