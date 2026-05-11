create table if not exists public.snapshot_cache (
  store_name text primary key,
  snapshot jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.snapshot_cache enable row level security;

revoke all on table public.snapshot_cache from public;
revoke all on table public.snapshot_cache from anon;
revoke all on table public.snapshot_cache from authenticated;

grant select, insert, update, delete on table public.snapshot_cache to service_role;
