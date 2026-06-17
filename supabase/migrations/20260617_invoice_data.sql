-- Invoice/tracking data per Google Calendar event (Jeff-only).
-- Keyed by google_event_id (unique per job).
-- workday_entries stores per-day start/end times as a JSONB array.

CREATE TABLE IF NOT EXISTS invoice_data (
  id                       UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  google_event_id          TEXT NOT NULL UNIQUE,
  la_number                TEXT,

  -- Invoice lifecycle status
  invoice_status           TEXT NOT NULL DEFAULT 'none',

  -- Per-day work entries: [{date, startTime, endTime}]
  workday_entries          JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Invoice rate defaults (overrideable)
  client                   TEXT NOT NULL DEFAULT 'Light Action',
  day_rate                 NUMERIC(10,2) NOT NULL DEFAULT 550.00,
  per_diem_rate            NUMERIC(10,2) NOT NULL DEFAULT 40.00,
  overtime_rate            NUMERIC(10,2) NOT NULL DEFAULT 82.50,

  -- Manual expense fields (all nullable)
  bag_fees                 NUMERIC(10,2),
  hotel                    NUMERIC(10,2),
  parking                  NUMERIC(10,2),
  tolls                    NUMERIC(10,2),
  uber                     NUMERIC(10,2),
  other_expenses           NUMERIC(10,2),
  expense_notes            TEXT,

  -- Mileage fields
  job_address              TEXT,
  total_miles              NUMERIC(10,2),
  mileage_rate             NUMERIC(10,4) NOT NULL DEFAULT 0.52,
  mileage_deduction_miles  INTEGER NOT NULL DEFAULT 60,

  -- Google Sheet sync tracking
  sheet_synced_at          TIMESTAMPTZ,
  sheet_sync_error         TEXT,

  -- Payment tracking
  paid_date                DATE,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Service-role-only access; no client-side access allowed.
ALTER TABLE invoice_data ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access"
  ON invoice_data
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Keep updated_at current automatically.
CREATE OR REPLACE FUNCTION update_invoice_data_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoice_data_updated_at
  BEFORE UPDATE ON invoice_data
  FOR EACH ROW EXECUTE FUNCTION update_invoice_data_updated_at();
