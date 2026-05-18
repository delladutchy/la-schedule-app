-- Phase 1.1: Add work_date to job_time_entries for multi-day job support.
-- One time entry per (google_event_id, editor_profile, work_date) triplet.
--
-- Run this once in the Supabase SQL editor.

-- 1. Add work_date as nullable so we can backfill before enforcing NOT NULL.
ALTER TABLE job_time_entries
  ADD COLUMN IF NOT EXISTS work_date DATE;

-- 2. Backfill existing rows.
--    Fallback: derive work date from created_at in America/New_York timezone.
--    Clock-in creates the row, so created_at ≈ work date for all early/test rows.
--    Edge case: a midnight clock-in spanning the tz boundary could be off by one.
UPDATE job_time_entries
  SET work_date = (created_at AT TIME ZONE 'America/New_York')::date
  WHERE work_date IS NULL;

-- 3. Enforce NOT NULL now that every row has a value.
ALTER TABLE job_time_entries
  ALTER COLUMN work_date SET NOT NULL;

-- 4. Drop old two-column unique constraint.
--    PostgreSQL names an inline UNIQUE as <table>_<col1>_<col2>_key.
ALTER TABLE job_time_entries
  DROP CONSTRAINT IF EXISTS job_time_entries_google_event_id_editor_profile_key;

-- 5. Add new three-column unique constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'job_time_entries_event_editor_date_key'
  ) THEN
    ALTER TABLE job_time_entries
      ADD CONSTRAINT job_time_entries_event_editor_date_key
        UNIQUE (google_event_id, editor_profile, work_date);
  END IF;
END;
$$;
