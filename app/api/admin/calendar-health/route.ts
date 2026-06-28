import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import { getStore } from "@netlify/blobs";
import { CALENDAR_SCOPES, buildCalendarAuth } from "@/lib/google";
import { getConfig } from "@/lib/config";
import { resolveCalendarHealthAuth } from "@/lib/calendar-health-auth";
import { isJeffEditorId } from "@/lib/job-time";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Private key reader (same sources as google-sheets.ts)
// ---------------------------------------------------------------------------

async function getPrivateKeyForCalendar(): Promise<{ key: string | null; source: "env" | "blobs" | "none" }> {
  const envKey = process.env.GOOGLE_PRIVATE_KEY?.trim();
  if (envKey) return { key: envKey, source: "env" };

  try {
    const store = getStore("app-secrets");
    const blobKey = await store.get("google-private-key");
    if (blobKey) return { key: blobKey, source: "blobs" };
  } catch {
    // Not in Netlify Blobs context (local dev without netlify dev).
  }

  return { key: null, source: "none" };
}

// ---------------------------------------------------------------------------
// Calendar access test — tries to fetch one event to verify read permission.
// Returns null on success, error message string on failure.
// Never logs or returns the private key.
// ---------------------------------------------------------------------------

async function testCalendarAccess(
  auth: InstanceType<typeof google.auth.GoogleAuth>,
  calendarId: string,
): Promise<string | null> {
  try {
    const cal = google.calendar({ version: "v3", auth: auth as unknown as ReturnType<typeof buildCalendarAuth> });
    await cal.calendarList.get({ calendarId });
    return null;
  } catch (err) {
    // calendarList.get doesn't work for non-primary calendars shared by ID.
    // Fall back to events.list (max 1 result) which tests actual read access.
    try {
      const cal = google.calendar({ version: "v3", auth: auth as unknown as ReturnType<typeof buildCalendarAuth> });
      await cal.events.list({
        calendarId,
        maxResults: 1,
        timeMin: new Date().toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });
      return null;
    } catch (err2) {
      const msg = err2 instanceof Error ? err2.message : String(err2);
      // Strip any token values that might appear in error objects, keep only
      // the human-readable portion (status + message, no request bodies).
      const safe = msg.replace(/access_token=[^&\s]+/gi, "[redacted]")
                      .replace(/Bearer [^\s]+/gi, "Bearer [redacted]")
                      .slice(0, 400);
      return safe;
    }
  }
}

// ---------------------------------------------------------------------------
// GET /api/admin/calendar-health
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const { env } = getConfig();
  const editorId = resolveCalendarHealthAuth(
    req.headers,
    req.nextUrl.searchParams.get("token"),
    env,
  );
  if (!editorId || !isJeffEditorId(editorId)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // ── Auth mode detection ────────────────────────────────────────────────────
  const saEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim() ?? null;
  const { key: rawKey, source: keySource } = await getPrivateKeyForCalendar();
  const privateKeyConfigured = !!rawKey;

  // Is OAuth2 configured (still needed for Gmail; also used as Calendar fallback)?
  const oauthClientId = process.env.GOOGLE_CLIENT_ID?.trim() ?? null;
  const oauthRefreshToken = process.env.GOOGLE_REFRESH_TOKEN?.trim() ?? null;
  const oauthConfigured = !!(oauthClientId && oauthRefreshToken);

  const authMode: "service_account" | "oauth2" | "none" =
    saEmail && privateKeyConfigured ? "service_account"
    : oauthConfigured              ? "oauth2"
    : "none";

  // ── Calendar IDs ──────────────────────────────────────────────────────────
  const laCalendarId   = process.env.GOOGLE_CALENDAR_ID?.trim() ?? null;
  const overtureId     = process.env.OVERTURE_CALENDAR_ID?.trim() ?? null;
  const blockerIdsRaw  = process.env.BLOCKER_CALENDAR_IDS?.trim() ?? "";
  const blockerIds     = blockerIdsRaw
    ? blockerIdsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  // Collect unique calendar IDs to test — LA calendar first, then any blockers
  // not already included, then Overture if set.
  const allIds = new Set<string>();
  if (laCalendarId) allIds.add(laCalendarId);
  for (const id of blockerIds) allIds.add(id);
  if (overtureId) allIds.add(overtureId);

  // ── Run access tests ───────────────────────────────────────────────────────
  type CalendarTest = {
    calendarId: string;
    label: string;
    success: boolean;
    error: string | null;
  };

  const tests: CalendarTest[] = [];

  if (authMode === "service_account" && saEmail && rawKey) {
    let auth: InstanceType<typeof google.auth.GoogleAuth> | null = null;
    let authBuildError: string | null = null;

    try {
      auth = new google.auth.GoogleAuth({
        credentials: {
          client_email: saEmail,
          private_key: rawKey.replace(/\\n/g, "\n"),
        },
        scopes: [...CALENDAR_SCOPES],
      });
    } catch (e) {
      authBuildError = e instanceof Error ? e.message.slice(0, 200) : String(e);
    }

    for (const calId of allIds) {
      const label =
        calId === laCalendarId  ? `LA Calendar (GOOGLE_CALENDAR_ID)`
        : calId === overtureId  ? `Overture (OVERTURE_CALENDAR_ID)`
        : blockerIds.includes(calId) ? `Blocker calendar`
        : calId;

      if (!auth) {
        tests.push({ calendarId: calId, label, success: false, error: authBuildError ?? "Failed to build auth" });
      } else {
        const err = await testCalendarAccess(auth, calId);
        tests.push({ calendarId: calId, label, success: err === null, error: err });
      }
    }
  } else if (authMode === "oauth2") {
    // OAuth2 path — just report IDs, don't actually test (token may be expired).
    for (const calId of allIds) {
      const label =
        calId === laCalendarId  ? `LA Calendar (GOOGLE_CALENDAR_ID)`
        : calId === overtureId  ? `Overture (OVERTURE_CALENDAR_ID)`
        : `Blocker calendar`;
      tests.push({
        calendarId: calId,
        label,
        success: false,
        error: "Auth mode is oauth2 — cannot test without making a refresh token call. Configure service account to enable this check.",
      });
    }
  } else {
    for (const calId of allIds) {
      tests.push({ calendarId: calId, label: calId, success: false, error: "No auth configured" });
    }
  }

  const overallSuccess = tests.length > 0 && tests.every((t) => t.success);
  const anyFailed = tests.some((t) => !t.success);

  // ── Human-readable diagnosis ───────────────────────────────────────────────
  let diagnosis: string;
  if (authMode === "none") {
    diagnosis = "No Calendar auth configured. Set GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY (preferred) or OAuth2 env vars.";
  } else if (authMode === "service_account" && !privateKeyConfigured) {
    diagnosis = "GOOGLE_SERVICE_ACCOUNT_EMAIL is set but no private key found in env or Netlify Blobs. Run POST /api/admin/migrate-sheets-key or set GOOGLE_PRIVATE_KEY env var.";
  } else if (authMode === "service_account" && overallSuccess) {
    diagnosis = "Service account auth is working and all tested calendars are accessible.";
  } else if (authMode === "service_account" && anyFailed) {
    const failedIds = tests.filter((t) => !t.success).map((t) => t.calendarId).join(", ");
    diagnosis = `Service account auth configured but access failed for: ${failedIds}. ` +
      `Share those calendars with ${saEmail ?? "the service account email"} and grant "Make changes to events" in Google Calendar settings.`;
  } else if (authMode === "oauth2") {
    diagnosis = "Using OAuth2 fallback. Configure GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY for stable, non-expiring auth.";
  } else {
    diagnosis = "Unknown state — check individual test results.";
  }

  return NextResponse.json(
    {
      authMode,
      serviceAccountEmail: saEmail,
      privateKeyConfigured,
      privateKeySource: keySource,
      oauthClientConfigured: !!oauthClientId,
      oauthRefreshTokenConfigured: !!oauthRefreshToken,
      calendarIds: {
        laCalendar: laCalendarId,
        overtureCalendar: overtureId,
        blockerCalendars: blockerIds,
      },
      tests,
      overallSuccess,
      diagnosis,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
