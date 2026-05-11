create table if not exists public.snapshot_cache (
  store_name text primary key,
  snapshot jsonb not null,
  updated_at timestamptz not null default now()
);
