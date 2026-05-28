# Security Notes — LA Schedule App

## Supabase RLS Hardening (2026-05-27)

### Background

Supabase Security Advisor flagged `rls_disabled_in_public`. This document records the
investigation, fix, and verification steps.

---

### Key Architecture Facts

- **One Supabase client** in the repo: `lib/supabase.ts` (marked `"server-only"`).
- **One key in use:** `SUPABASE_SERVICE_ROLE_KEY` — a server-only env var with no
  `NEXT_PUBLIC_` prefix and no client-bundle exposure.
- **No anon key.** No `NEXT_PUBLIC_SUPABASE_*` variables exist anywhere.
- **No browser Supabase client.** Zero calls to `createBrowserClient` or any anon-key
  pattern in `components/` or `app/`.
- **All Supabase access is through Next.js API routes** — authenticated by editor tokens
  before any DB call is made.

---

### Tables Found

| Table | Schema | Accessed by | Intended access model |
|---|---|---|---|
| `snapshot_cache` | public | `lib/store-supabase.ts` | Server-only (service_role) |
| `board_payload_cache` | public | `lib/board-payload-cache-supabase.ts` | Server-only (service_role) |
| `job_time_entries` | public | `lib/job-time.ts` | Server-only (service_role) |

All three tables are private, server-only stores. No client or anon access is intended
or needed for any of them.

---

### RLS Status Before Fix

| Table | RLS Enabled | Grants revoked from anon/authenticated |
|---|---|---|
| `snapshot_cache` | ✅ (migration 001) | ✅ |
| `board_payload_cache` | ✅ (migration 002) | ✅ |
| `job_time_entries` | ❌ MISSING | ❌ MISSING |

---

### Fix Applied

**Migration file:**
`supabase/migrations/20260527_job_time_entries_rls.sql`

**Exact SQL (paste in Supabase SQL editor if not auto-applied):**

```sql
alter table public.job_time_entries enable row level security;

revoke all on table public.job_time_entries from public;
revoke all on table public.job_time_entries from anon;
revoke all on table public.job_time_entries from authenticated;

grant select, insert, update, delete on table public.job_time_entries to service_role;
```

**Why no RLS policies are added:**
`service_role` in Supabase has `BYPASSRLS` at the PostgreSQL role level. Enabling RLS
without any explicit policies (and without `FORCE ROW LEVEL SECURITY`) means:

- `service_role`: table grants apply + bypasses RLS → **full access** (unchanged)
- `anon` / `authenticated`: table grants revoked + RLS active → **blocked entirely**
- No policy rows are needed to protect the table. The absence of policies means any
  non-bypassing role sees zero rows even if they somehow retained a grant.

---

### No Policies Needed

This is an intentional design. All three tables use the same model:
- Enable RLS
- Revoke grants from public/anon/authenticated
- Grant CRUD to service_role only
- Add no policies (service_role bypasses RLS; all other roles are blocked by grant revocation + RLS)

Do **not** add a policy like `USING (true)` to any of these tables without a proven
use case for public or authenticated access.

---

### How to Apply the Migration

**Option A — Supabase CLI (preferred):**
```
supabase db push
```

**Option B — Supabase Dashboard (manual paste):**
1. Open https://supabase.com/dashboard
2. Select the `la-schedule-app` project
3. Go to **SQL Editor**
4. Paste the exact SQL from the "Fix Applied" section above
5. Run it

---

### Rollback

If needed, the change can be reversed:

```sql
-- Rollback: disable RLS and restore default Supabase grants
alter table public.job_time_entries disable row level security;
grant all on table public.job_time_entries to anon;
grant all on table public.job_time_entries to authenticated;
```

⚠️ Do not roll back in production unless there is a specific operational reason.
Disabling RLS leaves the table unprotected.

---

### Post-Fix Verification Steps

1. **Supabase Security Advisor:** `rls_disabled_in_public` warning should disappear
   for `job_time_entries` after the migration runs.

2. **Functional test:** Clock In and Clock Out still work in the app (server routes use
   service_role and bypass RLS).

3. **Confirm no anon access:**
   ```sql
   -- Run in Supabase SQL editor as anon role (or check via API without auth):
   set role anon;
   select * from public.job_time_entries limit 1;
   -- Expected: ERROR: permission denied for table job_time_entries
   ```

4. **Confirm service_role still works:**
   - Trigger a Clock In through the app and verify the row is created in Supabase.

---

### What Will Disappear From Security Advisor After Fix

- `rls_disabled_in_public` for `job_time_entries` ✅

The two existing tables (`snapshot_cache`, `board_payload_cache`) were already correctly
hardened and should not appear in the advisor.

---

### Sensitive Key Exposure Audit (2026-05-27)

| Check | Result |
|---|---|
| `NEXT_PUBLIC_SUPABASE_*` vars | ❌ None found |
| Anon key in any file | ❌ None found |
| `createBrowserClient` usage | ❌ None found |
| `SUPABASE_SERVICE_ROLE_KEY` in client bundle | ❌ Not possible — `lib/supabase.ts` has `import "server-only"` |
| Service role key in `NEXT_PUBLIC_*` | ❌ No NEXT_PUBLIC_ prefix used |

**Result: No client-side key exposure found.**
