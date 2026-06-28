/**
 * Google Calendar client.
 *
 * We keep FreeBusy as the source of truth for conservative booked/available
 * projection, and optionally fetch event summaries for internal schedule labels.
 *
 * Why this shape:
 *   1. Existing availability behavior stays stable (still computed from FreeBusy).
 *   2. Internal schedule view can show event titles without exposing secrets
 *      client-side (titles are fetched server-side during sync only).
 *   3. Recurring events are expanded server-side by Google APIs.
 */

import { getStore } from "@netlify/blobs";
import { google } from "googleapis";
import { DateTime } from "luxon";
import type { Interval } from "./intervals";
import { classifyGoogleError } from "./google-error";

interface CalendarAuthOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

interface CalendarQueryOptions extends CalendarAuthOptions {
  calendarIds: string[];
  /** Inclusive start of the query window (UTC ms). */
  timeMinMs: number;
  /** Exclusive end of the query window (UTC ms). */
  timeMaxMs: number;
}

export interface FreeBusyOptions extends CalendarQueryOptions {
  /** Pre-warmed shared auth client; avoids a second concurrent token refresh. */
  sharedAuth?: CalendarAuth;
}

export interface FreeBusyResult {
  intervals: Interval[];
  /** Calendar ids that returned errors — caller decides fail-closed policy. */
  erroredCalendarIds: string[];
}

export interface CalendarEventsOptions extends CalendarQueryOptions {
  /** Display timezone used to interpret all-day date-only events. */
  displayTimezone: string;
  /** Pre-warmed shared auth client; avoids a second concurrent token refresh. */
  sharedAuth?: CalendarAuth;
}

export interface NamedCalendarEvent {
  startMs: number;
  endMs: number;
  summary: string;
  eventId?: string;
  description?: string;
  location?: string;
  ownerEditor?: string;
  calendarId: string;
}

export interface CalendarEventsResult {
  events: NamedCalendarEvent[];
  /** Calendar ids that returned errors — caller decides fail-closed policy. */
  erroredCalendarIds: string[];
}

export interface CreateAllDayEventOptions extends CalendarAuthOptions {
  calendarId: string;
  summary: string;
  description?: string;
  location?: string;
  ownerEditor?: string;
  eventId?: string;
  /** Inclusive local day in YYYY-MM-DD format. */
  startDate: string;
  /** Exclusive local day in YYYY-MM-DD format. */
  endDateExclusive: string;
  /** Pre-warmed shared auth — skips an extra token refresh inside this call. */
  sharedAuth?: CalendarAuth;
}

export interface CreatedCalendarEvent {
  id: string;
  status: string;
  htmlLink?: string;
}

export interface UpdateAllDayEventOptions extends CalendarAuthOptions {
  calendarId: string;
  eventId: string;
  summary: string;
  description?: string;
  location?: string;
  ownerEditor?: string;
  /** Inclusive local day in YYYY-MM-DD format. */
  startDate: string;
  /** Exclusive local day in YYYY-MM-DD format. */
  endDateExclusive: string;
  /** Pre-warmed shared auth — skips an extra token refresh inside this call. */
  sharedAuth?: CalendarAuth;
}

export interface DeletedCalendarEvent {
  id: string;
}

export interface RegisterCalendarWatchOptions extends CalendarAuthOptions {
  calendarId: string;
  webhookUrl: string;
  channelId: string;
  channelToken: string;
  /** Optional Google channel TTL in seconds (max 604800). */
  ttlSeconds?: number;
  /** Pre-warmed shared auth — preferred over building from OAuth2 credentials. */
  sharedAuth?: CalendarAuth;
}

export interface RegisteredCalendarWatch {
  channelId: string;
  resourceId: string;
  resourceUri?: string;
  expiration?: string;
}

export class CalendarEventAlreadyExistsError extends Error {
  constructor(message: string = "Calendar event already exists for this date range.") {
    super(message);
    this.name = "CalendarEventAlreadyExistsError";
  }
}

/**
 * Creates an OAuth2 client pre-seeded with the refresh token.
 *
 * The caller must eventually trigger a token fetch (either by calling
 * `auth.getAccessToken()` directly or by making an API call).  Exporting
 * this lets callers share one auth instance across concurrent requests so
 * they don't race each other to refresh the same token.
 */
export function buildCalendarAuth(opts: CalendarAuthOptions) {
  const auth = new google.auth.OAuth2(opts.clientId, opts.clientSecret);
  auth.setCredentials({ refresh_token: opts.refreshToken });
  return auth;
}

export type CalendarAuth = ReturnType<typeof buildCalendarAuth> | InstanceType<typeof google.auth.GoogleAuth>;

export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.events",
] as const;

/**
 * Builds a Calendar auth client using the service account already used for
 * Sheets (GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY).
 *
 * Returns null if the service account credentials are not configured, so
 * callers can fall back to OAuth2.
 *
 * One-time setup: share the LA Google Calendar with the service account email
 * and grant "Make changes to events" access in Google Calendar settings.
 * After that, auth never expires — no refresh tokens required.
 */
export async function buildCalendarServiceAccountAuth(): Promise<InstanceType<typeof google.auth.GoogleAuth> | null> {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  if (!email) return null;

  let rawKey: string | undefined = process.env.GOOGLE_PRIVATE_KEY;
  if (!rawKey) {
    try {
      const store = getStore("app-secrets");
      rawKey = (await store.get("google-private-key")) ?? undefined;
    } catch {
      // Not in Netlify Blobs context (local dev without netlify dev).
    }
  }
  if (!rawKey) return null;

  return new google.auth.GoogleAuth({
    credentials: {
      client_email: email,
      private_key: rawKey.replace(/\\n/g, "\n"),
    },
    scopes: [...CALENDAR_SCOPES],
  });
}

/**
 * Builds a CalendarAuth and calls getAccessToken() to obtain a live access
 * token before returning.  If the first attempt fails for any reason, a
 * brand-new client is created and tried once more after a short delay — a
 * fresh instance is required because a failed refresh leaves internal
 * credential state that prevents the same instance from retrying successfully.
 *
 * Throws the last error if both attempts fail.  Callers should classify
 * the thrown error with classifyGoogleError() to decide whether to surface
 * a permanent auth-failure message or to retry later.
 */
export async function buildWarmedCalendarAuth(opts: CalendarAuthOptions): Promise<CalendarAuth> {
  const ATTEMPTS = [0, 900] as const; // ms delay before each attempt
  let lastErr: unknown;
  for (const delay of ATTEMPTS) {
    if (delay > 0) await new Promise<void>((r) => setTimeout(r, delay));
    const auth = buildCalendarAuth(opts); // fresh instance every attempt
    try {
      await auth.getAccessToken();
      return auth;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function buildCalendarClient(opts: CalendarAuthOptions, sharedAuth?: CalendarAuth) {
  if (sharedAuth) {
    // Both OAuth2Client and GoogleAuth are valid Calendar auth clients.
    // googleapis overloads don't resolve the union, so we cast at the call site.
    return google.calendar({ version: "v3", auth: sharedAuth as ReturnType<typeof buildCalendarAuth> });
  }
  return google.calendar({ version: "v3", auth: buildCalendarAuth(opts) });
}

/**
 * Retry a Google API call once on transient (non-auth, non-rate-limit) errors.
 * Auth failures and rate limits are not retried — they require human action.
 */
async function retryOnTransient<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (firstErr) {
    const { isTransient } = classifyGoogleError(firstErr);
    if (!isTransient) throw firstErr;
    // One retry after a short back-off for transient issues (network blip, Google 5xx).
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
    return fn();
  }
}

/**
 * Query Google FreeBusy.
 *
 * Important:
 *   - FreeBusy has a 5-calendar limit per request, so we batch calendars.
 *   - FreeBusy can reject very large windows, so we chunk into 60-day slices.
 */
export async function fetchFreeBusy(opts: FreeBusyOptions): Promise<FreeBusyResult> {
  const calendar = buildCalendarClient(opts, opts.sharedAuth);

  const CALENDAR_CHUNK = 5;
  const TIME_CHUNK_DAYS = 60;
  const TIME_CHUNK_MS = TIME_CHUNK_DAYS * 24 * 60 * 60 * 1000;
  const allIntervals: Interval[] = [];
  const errored = new Set<string>();

  let chunkStartMs = opts.timeMinMs;
  while (chunkStartMs < opts.timeMaxMs) {
    const chunkEndMs = Math.min(chunkStartMs + TIME_CHUNK_MS, opts.timeMaxMs);
    const timeMin = new Date(chunkStartMs).toISOString();
    const timeMax = new Date(chunkEndMs).toISOString();

    for (let i = 0; i < opts.calendarIds.length; i += CALENDAR_CHUNK) {
      const calendarsChunk = opts.calendarIds.slice(i, i + CALENDAR_CHUNK);
      const resp = await retryOnTransient(() =>
        calendar.freebusy.query({
          requestBody: {
            timeMin,
            timeMax,
            items: calendarsChunk.map((id) => ({ id })),
          },
        }),
      );

      const calendars = resp.data.calendars ?? {};
      for (const id of calendarsChunk) {
        const cal = calendars[id];
        if (!cal) {
          errored.add(id);
          continue;
        }
        if (cal.errors && cal.errors.length > 0) {
          errored.add(id);
          continue;
        }
        for (const b of cal.busy ?? []) {
          if (!b.start || !b.end) continue;
          const startMs = Date.parse(b.start);
          const endMs = Date.parse(b.end);
          if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
          if (endMs <= startMs) continue;
          allIntervals.push({ startMs, endMs });
        }
      }
    }

    chunkStartMs = chunkEndMs;
  }

  return { intervals: allIntervals, erroredCalendarIds: [...errored] };
}

function parseEventBoundary(
  boundary: { dateTime?: string | null; date?: string | null } | null | undefined,
  displayTimezone: string,
): number | null {
  if (!boundary) return null;

  if (boundary.dateTime) {
    const ms = Date.parse(boundary.dateTime);
    return Number.isFinite(ms) ? ms : null;
  }

  if (boundary.date) {
    // Date-only (all-day) events are interpreted in the display timezone.
    const dt = DateTime.fromISO(boundary.date, { zone: displayTimezone }).startOf("day");
    return dt.isValid ? dt.toUTC().toMillis() : null;
  }

  return null;
}

function parseOwnerEditor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(normalized)) return undefined;
  return normalized;
}

function trimLocation(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Query Google Calendar Events for titles and boundaries.
 *
 * We chunk by time range to match FreeBusy windowing and keep request sizes bounded.
 * A single-calendar events.list call can paginate, so we iterate nextPageToken.
 */
export async function fetchCalendarEvents(
  opts: CalendarEventsOptions,
): Promise<CalendarEventsResult> {
  const calendar = buildCalendarClient(opts, opts.sharedAuth);

  const TIME_CHUNK_DAYS = 60;
  const TIME_CHUNK_MS = TIME_CHUNK_DAYS * 24 * 60 * 60 * 1000;
  const events: NamedCalendarEvent[] = [];
  const errored = new Set<string>();

  let chunkStartMs = opts.timeMinMs;
  while (chunkStartMs < opts.timeMaxMs) {
    const chunkEndMs = Math.min(chunkStartMs + TIME_CHUNK_MS, opts.timeMaxMs);
    const timeMin = new Date(chunkStartMs).toISOString();
    const timeMax = new Date(chunkEndMs).toISOString();

    for (const calendarId of opts.calendarIds) {
      if (errored.has(calendarId)) continue;

      let pageToken: string | undefined;
      do {
        let resp;
        try {
          resp = await retryOnTransient(() =>
            calendar.events.list({
              calendarId,
              timeMin,
              timeMax,
              singleEvents: true,
              orderBy: "startTime",
              maxResults: 2500,
              pageToken,
              timeZone: opts.displayTimezone,
              fields: "items(id,status,transparency,summary,description,location,extendedProperties(private(ownerEditor)),start(date,dateTime),end(date,dateTime)),nextPageToken",
            }),
          );
        } catch {
          errored.add(calendarId);
          pageToken = undefined;
          break;
        }

        for (const item of resp.data.items ?? []) {
          if (item.status === "cancelled") continue;
          if (item.transparency === "transparent") continue;

          const startMs = parseEventBoundary(item.start, opts.displayTimezone);
          const endMs = parseEventBoundary(item.end, opts.displayTimezone);
          if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
          if ((endMs as number) <= (startMs as number)) continue;

          const summary = (item.summary ?? "").trim() || "Busy";
          const ownerEditor = parseOwnerEditor(item.extendedProperties?.private?.ownerEditor);
          const location = trimLocation(item.location);
          events.push({
            startMs: startMs as number,
            endMs: endMs as number,
            summary,
            ...(item.id ? { eventId: item.id } : {}),
            ...(item.description ? { description: item.description } : {}),
            ...(location ? { location } : {}),
            ...(ownerEditor ? { ownerEditor } : {}),
            calendarId,
          });
        }

        pageToken = resp.data.nextPageToken ?? undefined;
      } while (pageToken);
    }

    chunkStartMs = chunkEndMs;
  }

  const deduped = new Map<string, NamedCalendarEvent>();
  for (const event of events) {
    const key = event.eventId
      ? `${event.calendarId}|id|${event.eventId}`
      : `${event.calendarId}|${event.startMs}|${event.endMs}|${event.summary}`;
    if (!deduped.has(key)) deduped.set(key, event);
  }

  const sorted = [...deduped.values()].sort((a, b) => {
    if (a.startMs !== b.startMs) return a.startMs - b.startMs;
    if (a.endMs !== b.endMs) return a.endMs - b.endMs;
    return a.summary.localeCompare(b.summary);
  });

  return { events: sorted, erroredCalendarIds: [...errored] };
}

export async function registerCalendarWatch(
  opts: RegisterCalendarWatchOptions,
): Promise<RegisteredCalendarWatch> {
  const calendar = buildCalendarClient(opts, opts.sharedAuth);
  const ttlSeconds = opts.ttlSeconds ? Math.max(60, Math.min(604800, Math.floor(opts.ttlSeconds))) : 604800;

  const response = await calendar.events.watch({
    calendarId: opts.calendarId,
    requestBody: {
      id: opts.channelId,
      token: opts.channelToken,
      type: "web_hook",
      address: opts.webhookUrl,
      params: {
        ttl: String(ttlSeconds),
      },
    },
    fields: "id,resourceId,resourceUri,expiration",
  });

  const channelId = response.data.id?.trim();
  const resourceId = response.data.resourceId?.trim();
  if (!channelId || !resourceId) {
    throw new Error("Google watch registration did not return channel/resource ids.");
  }

  const expirationMs = response.data.expiration ? Number(response.data.expiration) : null;
  const expiration = Number.isFinite(expirationMs)
    ? new Date(expirationMs as number).toISOString()
    : undefined;

  return {
    channelId,
    resourceId,
    ...(response.data.resourceUri ? { resourceUri: response.data.resourceUri } : {}),
    ...(expiration ? { expiration } : {}),
  };
}


export async function createAllDayEvent(
  opts: CreateAllDayEventOptions,
): Promise<CreatedCalendarEvent> {
  const calendar = buildCalendarClient(opts, opts.sharedAuth);
  let response;
  try {
    response = await retryOnTransient(() =>
      calendar.events.insert({
        calendarId: opts.calendarId,
        requestBody: {
          ...(opts.eventId ? { id: opts.eventId } : {}),
          summary: opts.summary.trim(),
          ...(opts.description?.trim()
            ? { description: opts.description.trim() }
            : {}),
          ...(opts.location?.trim()
            ? { location: opts.location.trim() }
            : {}),
          ...(opts.ownerEditor
            ? {
                extendedProperties: {
                  private: {
                    ownerEditor: opts.ownerEditor,
                  },
                },
              }
            : {}),
          start: { date: opts.startDate },
          end: { date: opts.endDateExclusive },
          transparency: "opaque",
        },
        fields: "id,status,htmlLink",
      }),
    );
  } catch (error: unknown) {
    const status = typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: number }).status
      : undefined;
    if (status === 409) {
      throw new CalendarEventAlreadyExistsError();
    }
    throw error;
  }

  const id = response.data.id?.trim();
  const status = response.data.status?.trim();
  if (!id || !status) {
    throw new Error("Google Calendar did not return a valid event id/status.");
  }

  return {
    id,
    status,
    ...(response.data.htmlLink ? { htmlLink: response.data.htmlLink } : {}),
  };
}

export async function updateAllDayEvent(
  opts: UpdateAllDayEventOptions,
): Promise<CreatedCalendarEvent> {
  const calendar = buildCalendarClient(opts, opts.sharedAuth);
  const response = await retryOnTransient(() =>
    calendar.events.patch({
      calendarId: opts.calendarId,
      eventId: opts.eventId,
      requestBody: {
        summary: opts.summary.trim(),
        ...(opts.description?.trim()
          ? { description: opts.description.trim() }
          : { description: "" }),
        ...(opts.location?.trim()
          ? { location: opts.location.trim() }
          : { location: "" }),
        ...(opts.ownerEditor
          ? {
              extendedProperties: {
                private: {
                  ownerEditor: opts.ownerEditor,
                },
              },
            }
          : {}),
        start: { date: opts.startDate },
        end: { date: opts.endDateExclusive },
        transparency: "opaque",
      },
      fields: "id,status,htmlLink",
    }),
  );

  const id = response.data.id?.trim();
  const status = response.data.status?.trim();
  if (!id || !status) {
    throw new Error("Google Calendar did not return a valid event id/status.");
  }

  return {
    id,
    status,
    ...(response.data.htmlLink ? { htmlLink: response.data.htmlLink } : {}),
  };
}

export async function deleteCalendarEvent(
  opts: CalendarAuthOptions & { calendarId: string; eventId: string; sharedAuth?: CalendarAuth },
): Promise<DeletedCalendarEvent> {
  const calendar = buildCalendarClient(opts, opts.sharedAuth);
  await retryOnTransient(() =>
    calendar.events.delete({
      calendarId: opts.calendarId,
      eventId: opts.eventId,
    }),
  );
  return { id: opts.eventId };
}
