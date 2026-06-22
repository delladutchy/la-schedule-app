-- Invoice receipt attachments
-- Files stored in Supabase Storage bucket: invoice-attachments
-- This table stores metadata only; actual files live in Storage.

-- ── Storage bucket ────────────────────────────────────────────────────────────
-- Create the bucket declaratively so it exists after migration, independent of
-- any first-upload. Private (public=false): files are never URL-accessible
-- without a short-lived signed URL generated server-side via service role.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'invoice-attachments',
  'invoice-attachments',
  false,                -- never publicly accessible
  20971520,             -- 20 MB per file
  array[
    'image/jpeg', 'image/png', 'image/webp',
    'image/gif', 'image/heic', 'image/heif',
    'application/pdf'
  ]
)
on conflict (id) do nothing;

-- ── Storage access policies ───────────────────────────────────────────────────
-- All app access goes through the service role key (server-side only).
-- The service role bypasses RLS entirely, so no permissive policies are needed.
-- Intentionally NO anon or authenticated policies: direct client-side access
-- to this bucket is blocked by design. Signed URLs (server-generated, 1-hour
-- expiry) are the only way to view individual files.

-- ── Metadata table ────────────────────────────────────────────────────────────

create table if not exists invoice_attachments (
  id                uuid primary key default gen_random_uuid(),
  google_event_id   text not null,
  invoice_number    text,
  la_job_number     text,
  original_filename text not null,
  storage_path      text not null unique,
  mime_type         text not null,
  size_bytes        bigint not null default 0,
  include_in_email  boolean not null default true,
  uploaded_by       text,
  created_at        timestamptz not null default now(),
  archived_at       timestamptz
);

create index if not exists invoice_attachments_event_id_idx
  on invoice_attachments (google_event_id)
  where archived_at is null;

-- Enable RLS. All app access is via service role (bypasses RLS).
-- This blocks any accidental anon/authenticated queries via the Supabase
-- client if ever used without service role.
alter table invoice_attachments enable row level security;

comment on table invoice_attachments is
  'Receipt and document attachments for invoices. Files stored in Supabase Storage bucket invoice-attachments.';
comment on column invoice_attachments.storage_path is
  'Path within the invoice-attachments Storage bucket. Never expose publicly; generate signed URLs server-side.';
comment on column invoice_attachments.include_in_email is
  'When true, this attachment is included with the Send Invoice email.';
comment on column invoice_attachments.archived_at is
  'Soft-delete timestamp. Archived attachments are not shown in UI or sent in email.';
