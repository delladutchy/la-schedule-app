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

import { google } from "googleapis";
import { DateTime } from "luxon";
import type { Interval } from "./intervals";

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

export interface FreeBusyOptions extends CalendarQueryOptions {}

export interface FreeBusyResult {
  intervals: Interval[];
  /** Calendar ids that returned errors — caller decides fail-closed policy. */
  erroredCalendarIds: string[];
}

export interface CalendarEventsOptions extends CalendarQueryOptions {
  /** Display timezone used to interpret all-day date-only events. */
  displayTimezone: string;
}

export interface NamedCalendarEvent {
  startMs: number;
  endMs: number;
  summary: string;
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
  eventId?: string;
  /** Inclusive local day in YYYY-MM-DD format. */
  startDate: string;
  /** Exclusive local day in YYYY-MM-DD format. */
  endDateExclusive: string;
}

export interface CreatedCalendarEvent {
  id: string;
  status: string;
  htmlLink?: string;
}

export class CalendarEventAlreadyExistsError extends Error {
  constructor(message: string = "Calendar event already exists for this date range.") {
    super(message);
    this.name = "CalendarEventAlreadyExistsError";
  }
}

function buildCalendarClient(opts: CalendarAuthOptions) {
  const auth = new google.auth.OAuth2(opts.clientId, opts.clientSecret);
  auth.setCredentials({ refresh_token: opts.refreshToken });
  return google.calendar({ version: "v3", auth });
}

/**
 * Query Google FreeBusy.
 *
 * Important:
 *   - FreeBusy has a 5-calendar limit per request, so we batch calendars.
 *   - FreeBusy can reject very large windows, so we chunk into 60-day slices.
 */
export async function fetchFreeBusy(opts: FreeBusyOptions): Promise<FreeBusyResult> {
  const calendar = buildCalendarClient(opts);

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
      const resp = await calendar.freebusy.query({
        requestBody: {
          timeMin,
          timeMax,
          items: calendarsChunk.map((id) => ({ id })),
        },
      });

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

/**
 * Query Google Calendar Events for titles and boundaries.
 *
 * We chunk by time range to match FreeBusy windowing and keep request sizes bounded.
 * A single-calendar events.list call can paginate, so we iterate nextPageToken.
 */
export async function fetchCalendarEvents(
  opts: CalendarEventsOptions,
): Promise<CalendarEventsResult> {
  const calendar = buildCalendarClient(opts);

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
          resp = await calendar.events.list({
            calendarId,
            timeMin,
            timeMax,
            singleEvents: true,
            orderBy: "startTime",
            maxResults: 2500,
            pageToken,
            timeZone: opts.displayTimezone,
            fields: "items(status,transparency,summary,start(date,dateTime),end(date,dateTime)),nextPageToken",
          });
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
          events.push({
            startMs: startMs as number,
            endMs: endMs as number,
            summary,
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
    const key = `${event.calendarId}|${event.startMs}|${event.endMs}|${event.summary}`;
    if (!deduped.has(key)) deduped.set(key, event);
  }

  const sorted = [...deduped.values()].sort((a, b) => {
    if (a.startMs !== b.startMs) return a.startMs - b.startMs;
    if (a.endMs !== b.endMs) return a.endMs - b.endMs;
    return a.summary.localeCompare(b.summary);
  });

  return { events: sorted, erroredCalendarIds: [...errored] };
}


export async function createAllDayEvent(
  opts: CreateAllDayEventOptions,
): Promise<CreatedCalendarEvent> {
  const calendar = buildCalendarClient(opts);
  let response;
  try {
    response = await calendar.events.insert({
      calendarId: opts.calendarId,
      requestBody: {
        ...(opts.eventId ? { id: opts.eventId } : {}),
        summary: opts.summary.trim(),
        ...(opts.description?.trim()
          ? { description: opts.description.trim() }
          : {}),
        start: { date: opts.startDate },
        end: { date: opts.endDateExclusive },
        transparency: "opaque",
      },
      fields: "id,status,htmlLink",
    });
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
