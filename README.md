# Availability

A read-only, enterprise-clean availability page backed by a cached snapshot of
your Google Calendar.

**Not** a booking tool. Nobody picks a slot, nobody books anything, no meeting
is ever created. It only shows when you are busy vs. available to work so a
third party can glance at your schedule before reaching out.

---

## Why it looks the way it does

The #1 goal is that this page is rock-solid when a company opens it. That
drove every architectural choice:

```
 Google Calendar (FreeBusy API)
          │
          ▼
 Netlify Scheduled Function        ← every 10 minutes
          │
          ▼
 Netlify Blobs (snapshot JSON)     ← normalized, merged, timezone-safe
          │
          ▼
 Next.js public page (ISR)         ← reads snapshot, never calls Google
```

**The public page never calls Google.** If Google is slow, rate-limiting us,
or completely down, the page still renders the last known-good snapshot. If
that snapshot gets too old (`hardTtlMinutes`), the page fails closed with
"Availability temporarily unavailable" rather than guessing.

**We use FreeBusy, not Events.** FreeBusy returns only `(start, end)` tuples —
no titles, no attendees, no locations. We cannot accidentally leak a private
event detail because we never fetched one.

**Only allow-listed calendars count.** `BLOCKER_CALENDAR_IDS` is an env-var
allow-list. Birthdays, tasks, personal calendars are ignored.

---

## Tech

- **Next.js 14** (App Router, TypeScript strict, ISR for the public page)
- **Netlify** for hosting, Scheduled Functions, and Blobs storage
- **Luxon** for DST-safe timezone handling
- **Zod** for schema validation (env, config file, snapshot on read and write)
- **Vitest** for the test suite

Minimal runtime deps, mainstream stack, nothing trendy.

---

## Project layout

```
app/
  layout.tsx              # global shell
  globals.css             # enterprise-clean styles, light/dark
  page.tsx                # PUBLIC availability page (ISR)
  admin/page.tsx          # token-gated status page
  api/sync/route.ts       # token-gated manual sync endpoint
components/
  WeekGrid.tsx            # desktop weekly grid
  DayList.tsx             # mobile-friendly list view
lib/
  config.ts               # Zod-validated runtime config
  types.ts                # domain types + Zod schemas
  intervals.ts            # PURE: merge / buffer / subtract logic
  time.ts                 # Luxon-backed day & slot generation
  google.ts               # FreeBusy client (refresh-token OAuth)
  store.ts                # Netlify Blobs read/write
  sync.ts                 # end-to-end pipeline
  view.ts                 # snapshot → day views; freshness classifier
netlify/functions/
  scheduled-sync.ts       # runs every 10 minutes
scripts/
  google-auth.ts          # one-time refresh-token helper
  sync-local.ts           # prime first snapshot from your laptop
tests/                    # vitest suite
config/
  availability.config.json  # non-secret config, git-tracked
```

---

## First-time setup

### 1. Clone and install

```bash
git clone <your-repo>
cd availability
npm install
```

### 2. Create a Google Cloud OAuth client

1. Open the [Google Cloud console](https://console.cloud.google.com/) and
   create a project (or pick an existing one).
2. Enable the **Google Calendar API**:
   [API library](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
3. Configure the **OAuth consent screen**:
   - User type: **External** (fine for a single-user tool) or **Internal**
     if you're on Workspace.
   - Scopes: add `.../auth/calendar.freebusy`.
   - Test users: add your own Google account.
   - **Important:** while the app is in "Testing" status, Google expires
     refresh tokens after **7 days**. For long-term use you should click
     **Publish app** on the consent screen. Google's consent-screen UI
     will tell you at publish time whether the scope you requested needs
     verification — as of writing, `calendar.freebusy` typically does not,
     but confirm in the UI. If verification is required and you don't want
     to go through it, you can keep re-running `npm run google:auth` weekly,
     or switch to a Google Workspace account with **Internal** user type,
     which has no expiration.
4. Create an **OAuth 2.0 Client ID**:
   [Credentials](https://console.cloud.google.com/apis/credentials)
   - Application type: **Desktop app**.
   - Note the **Client ID** and **Client secret**.

### 3. Produce your refresh token (one time, on your laptop)

```bash
GOOGLE_CLIENT_ID=<...> \
GOOGLE_CLIENT_SECRET=<...> \
npm run google:auth
```

This opens your browser, you approve the `calendar.freebusy` scope, and the
script prints a refresh token. **Copy it.** It doesn't write anything to
disk.

### 4. Find your blocker calendar IDs

In Google Calendar → Settings → scroll to each calendar → "Integrate calendar"
→ **Calendar ID**.

- Your main calendar: `primary`
- "LA Jobs": looks like `abcd1234...@group.calendar.google.com`
- "Jeff - Availability": same format

Do **not** add birthdays, tasks, personal, or holidays. Those are not work
blockers and they'll cause false busies.

### 5. Configure the page

Edit `config/availability.config.json`:

```jsonc
{
  "timezone": "America/Los_Angeles",     // your display timezone
  "workdayStartHour": 9,                 // 9 AM
  "workdayEndHour": 18,                  // 6 PM
  "hideWeekends": true,
  "slotMinutes": 30,                     // 15 | 30 | 60
  "preBufferMinutes": 0,                 // e.g. 15 to pad before meetings
  "postBufferMinutes": 0,
  "horizonDays": 14,                     // how far ahead to show
  "showTentative": false,                // treat tentative events as busy
  "freshTtlMinutes": 30,                 // snapshot older than this → "stale" banner
  "hardTtlMinutes": 180,                 // snapshot older than this → fail-closed
  "pageTitle": "Availability",
  "pageSubtitle": "Reflects selected work calendars only",
  "footerNote": "All times shown in the timezone noted above. For the most accurate scheduling, please confirm directly."
}
```

---

## Deploying to Netlify

### 1. Create the site

```bash
# Push this repo to GitHub (or GitLab/Bitbucket)
# Then in the Netlify UI: New site from Git → pick the repo.
```

Netlify will auto-detect Next.js via `@netlify/plugin-nextjs` declared in
`netlify.toml`.

### 2. Set env vars

In the Netlify site → **Site configuration** → **Environment variables**, add:

| Key | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | from Google Cloud |
| `GOOGLE_CLIENT_SECRET` | from Google Cloud |
| `GOOGLE_REFRESH_TOKEN` | output of `npm run google:auth` |
| `BLOCKER_CALENDAR_IDS` | comma-separated, e.g. `primary,abcd1234...@group.calendar.google.com` |
| `ADMIN_TOKEN` | `openssl rand -hex 32` |

All scopes (`Production`, `Deploy previews`, `Branch deploys`) are fine.

### 3. Deploy

Trigger a deploy. Netlify will:
- build the Next.js app
- register `scheduled-sync` with its cron (`*/10 * * * *`)
- bind Netlify Blobs automatically (no extra config)

### 4. Prime the first snapshot

Right after the first deploy, the scheduled function may not have run yet.
Prime the snapshot manually:

```bash
curl -X POST \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://your-site.netlify.app/api/sync
```

Expected response:

```json
{ "status": "ok", "durationMs": 412, "busyBlocks": 37, "generatedAtUtc": "2026-04-22T18:30:00.000Z" }
```

### 5. Verify

- Visit the public page at the site root. You should see a clean weekly grid.
- Visit `https://your-site.netlify.app/admin?token=$ADMIN_TOKEN` to confirm
  snapshot freshness.

---

## Operations

### Forcing a sync

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://your-site.netlify.app/api/sync
```

Use this after changing blocker calendar IDs, or if you moved a bunch of
meetings and want the page to reflect it immediately instead of waiting up
to 10 minutes.

### Checking sync health

Visit `/admin?token=$ADMIN_TOKEN`. It shows snapshot age, source calendars,
window, and the config in use. No event details are ever displayed.

You can also view Function logs in the Netlify UI → **Functions** →
**scheduled-sync**. Every run logs `[scheduled-sync] ok in Xms, N busy blocks`
or a structured error.

### Changing config

Edit `config/availability.config.json`, commit, push. Netlify redeploys.
All changes go through git, so you have history and rollback for free.

### Rotating the refresh token

1. Revoke access at https://myaccount.google.com/permissions
2. Rerun `npm run google:auth`
3. Update `GOOGLE_REFRESH_TOKEN` in Netlify
4. Redeploy (or trigger a sync)

### Adding/removing a blocker calendar

Update `BLOCKER_CALENDAR_IDS` in Netlify env vars, trigger a sync.

---

## Reliability behavior (what happens when things go wrong)

| Failure | What the public page does |
|---|---|
| Google FreeBusy returns 5xx | Scheduled function fails, no new snapshot written, page keeps serving the old one |
| Google rate-limits us | Same as above |
| A single blocker calendar returns an error | **Entire sync aborts**, old snapshot preserved — we never want to show "free" when we couldn't read one calendar |
| Netlify Blobs read fails | Page shows fail-closed "Availability temporarily unavailable" |
| Snapshot file is corrupted | Zod rejects it, treated as missing, fail-closed |
| Snapshot age > `freshTtlMinutes` (default 30) | Page still renders, yellow banner noting last-updated time |
| Snapshot age > `hardTtlMinutes` (default 180) | **Fail-closed** — shows "temporarily unavailable" instead of possibly-wrong data |
| Scheduled function is delayed | Up to 3 hours of tolerance before fail-closed kicks in |

**Fail-closed is the whole point.** We'd rather show "unavailable" than
accidentally show you as free when you're not.

---

## Privacy & security

- **Read-only scope.** The OAuth scope is `calendar.freebusy` — strictly
  less than `calendar.readonly`. We can't read event titles even if we
  wanted to.
- **No tokens ever reach the browser.** Every Google call happens on Netlify,
  server-side. The public HTML contains only normalized busy intervals
  (start/end UTC timestamps).
- **No event details in the snapshot.** The snapshot JSON contains only
  `{ startUtc, endUtc }` tuples — it's structurally impossible to leak a
  title via it because a title was never fetched.
- **Admin endpoints use constant-time token comparison.** See
  `app/api/sync/route.ts` and `app/admin/page.tsx`.
- **Snapshot Zod-validated on both write and read.** A corrupted blob is
  treated as missing, not trusted.
- **Env vars validated at startup.** Zod-parsed on first access; app
  refuses to serve if misconfigured.
- **Security headers** (`X-Frame-Options`, `Referrer-Policy`, HSTS,
  `Permissions-Policy`) set in `netlify.toml`.
- **`robots: noindex`** by default. Share the URL intentionally; don't let
  it get crawled by accident.

---

## Running tests

```bash
npm test          # run once
npm run test:watch
npm run typecheck
```

The test suite covers:
- Interval merging (overlapping, adjacent, chained, out-of-order, nested)
- Buffer application
- Subtraction (free-gap computation)
- Confirmed-vs-tentative merge semantics (regression-tested)
- Day/slot building at DST spring-forward and fall-back boundaries
- All-day and multi-day events
- Timezone rendering
- Freshness classification (ok / stale / unavailable boundaries)
- Snapshot schema validation

---

## Local development

```bash
# Install Netlify CLI once
npm i -g netlify-cli

# Link your clone to the Netlify site
netlify link

# Pull env vars from Netlify into .env.local
netlify env:import .env.local
# (or: netlify env:list, and copy into .env.local manually)

# Run the app locally. Use `netlify dev` so Blobs and env vars work.
netlify dev

# In another terminal, prime a snapshot:
netlify dev:exec tsx scripts/sync-local.ts
```

---

## FAQ

**Why not use a service account?**
Service accounts with domain-wide delegation require Google Workspace admin
rights. A refresh token works for any Google account and is simpler for a
single-user tool. If you ever move this to a Workspace and want to eliminate
the single-token failure mode, swap `lib/google.ts` to use
`google.auth.JWT` with a service account key.

**Why not Vercel?**
Netlify does everything we need (static hosting + Scheduled Functions +
Blobs + a Next.js runtime) and you already have a subscription. There's no
reliability argument for moving — both platforms have comparable uptime, and
this workload is not Vercel-specific in any way.

**Why isn't the sync on page load?**
That would make every visit dependent on Google responding in time. It also
turns every visit into a Google API call, which eats quota. The 10-minute
snapshot cadence is the reliability lever.

**Why the 30 / 180 minute TTLs?**
- 30 min (fresh): a normal 10-min cron has up to 20 min of skew in the worst
  case, so 30 min is a comfortable "everything is working" window.
- 180 min (hard): enough for a 3-hour cloud outage or OAuth hiccup before we
  fail closed. If you want to be more aggressive, shorten it.
