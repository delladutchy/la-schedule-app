-- Phase 1: Jeff-only time tracking for LA schedule jobs
-- Stores private clock-in / clock-out data keyed by Google Calendar event id.
-- Supabase service role key (server-only) is the sole access path.

create table if not exists job_time_entries (
  id               uuid        primary key default gen_random_uuid(),
  google_event_id  text        not null,
  la_number        text,
  editor_profile   text        not null default 'jeff',
  clock_in_at      timestamptz,
  clock_out_at     timestamptz,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (google_event_id, editor_profile)
);

-- Keep updated_at current on every row change.
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger job_time_entries_updated_at
  before update on job_time_entries
  for each row execute procedure set_updated_at();
