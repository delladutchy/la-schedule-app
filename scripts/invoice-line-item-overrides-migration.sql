-- Add flexible manual line-item override storage for native invoice adjustments.
-- Safe to run more than once in Supabase SQL Editor.
--
-- Null/missing JSON keys mean "use the automatic invoice calculation".
-- Example:
-- {
--   "day_rate": { "qty": 2.5, "rate": 600, "amount": 1500 },
--   "parking": { "amount": 110 }
-- }

ALTER TABLE public.invoice_data
  ADD COLUMN IF NOT EXISTS invoice_line_item_overrides JSONB DEFAULT '{}'::jsonb;

UPDATE public.invoice_data
SET invoice_line_item_overrides = '{}'::jsonb
WHERE invoice_line_item_overrides IS NULL;

ALTER TABLE public.invoice_data
  ALTER COLUMN invoice_line_item_overrides SET DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.invoice_data.invoice_line_item_overrides IS
  'Manual native invoice line-item qty/rate/amount overrides. Missing keys use automatic calculations.';
