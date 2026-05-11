create table if not exists public.board_payload_cache (
  view_mode text not null,
  week_start date not null,
  month_key text not null,
  editor_bucket text not null,
  scope text not null,
  payload jsonb not null,
  generated_at_utc timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (view_mode, week_start, month_key, editor_bucket, scope)
);

alter table public.board_payload_cache enable row level security;

revoke all on table public.board_payload_cache from public;
revoke all on table public.board_payload_cache from anon;
revoke all on table public.board_payload_cache from authenticated;

grant select, insert, update, delete on table public.board_payload_cache to service_role;
