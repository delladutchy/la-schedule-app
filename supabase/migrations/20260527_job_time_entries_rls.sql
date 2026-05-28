-- Harden job_time_entries: enable RLS and lock down table-level grants.
--
-- All access to this table is server-side via the Supabase service_role key
-- (lib/supabase.ts, marked "server-only"). No anon or authenticated browser
-- client ever touches this table.
--
-- service_role in Supabase has BYPASSRLS, so enabling RLS without policies
-- (not FORCE ROW LEVEL SECURITY) keeps service_role access intact while
-- blocking every other role.

alter table public.job_time_entries enable row level security;

revoke all on table public.job_time_entries from public;
revoke all on table public.job_time_entries from anon;
revoke all on table public.job_time_entries from authenticated;

grant select, insert, update, delete on table public.job_time_entries to service_role;
