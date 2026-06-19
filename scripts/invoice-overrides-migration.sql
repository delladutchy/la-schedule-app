-- Add invoice text override columns to invoice_data table.
-- Run once in Supabase SQL Editor. Safe to re-run (ADD COLUMN IF NOT EXISTS).
--
-- These columns store optional user-edited overrides for PDF/email text.
-- Null = use auto-generated value. Non-null = use this instead.

ALTER TABLE invoice_data
  ADD COLUMN IF NOT EXISTS invoice_job_name_override TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS invoice_day_rate_description_override TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS invoice_ot_description_override TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS invoice_per_diem_description_override TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS invoice_bag_fees_description_override TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS invoice_parking_description_override TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS invoice_uber_description_override TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS invoice_tolls_description_override TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS invoice_hotel_description_override TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS invoice_other_description_override TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS invoice_note_override TEXT DEFAULT NULL;

COMMENT ON COLUMN invoice_data.invoice_job_name_override IS
  'Optional override for the job name shown on PDF, email body, and attachment filename. Null = use cleaned calendar title.';
COMMENT ON COLUMN invoice_data.invoice_day_rate_description_override IS
  'Optional override for the Day Rate description column in the PDF. Null = use auto-generated date/time lines.';
COMMENT ON COLUMN invoice_data.invoice_ot_description_override IS
  'Optional override for the Overtime description column in the PDF. Null = use default text.';
COMMENT ON COLUMN invoice_data.invoice_per_diem_description_override IS
  'Optional override for the Per Diem description column in the PDF. Null = blank.';
COMMENT ON COLUMN invoice_data.invoice_bag_fees_description_override IS
  'Optional override for the Bag Fees description column in the PDF. Null = blank.';
COMMENT ON COLUMN invoice_data.invoice_parking_description_override IS
  'Optional override for the Parking description column in the PDF. Null = blank.';
COMMENT ON COLUMN invoice_data.invoice_uber_description_override IS
  'Optional override for the Uber description column in the PDF. Null = blank.';
COMMENT ON COLUMN invoice_data.invoice_tolls_description_override IS
  'Optional override for the Tolls description column in the PDF. Null = blank.';
COMMENT ON COLUMN invoice_data.invoice_hotel_description_override IS
  'Optional override for the Hotel description column in the PDF. Null = blank.';
COMMENT ON COLUMN invoice_data.invoice_other_description_override IS
  'Optional override for the Other description column in the PDF. Null = blank.';
COMMENT ON COLUMN invoice_data.invoice_note_override IS
  'Optional override for the "Note to customer" section in the PDF. Null = use default "Thanks again, Jeff".';
