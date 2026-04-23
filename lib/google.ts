/**
 * Google Calendar FreeBusy client.
 *
 * We deliberately use the FreeBusy API — not Events — because:
 *   1. Privacy by architecture: FreeBusy returns only (start, end) tuples,
 *      never titles, descriptions, attendees, locations. There is no
 *      possible path by which a private detail could leak to the public
 *      page, because we never received one.
 *   2. Simpler: Google handles recurring-event expansion server-side.
 *   3. Reliable: one request, multiple calendars, bounded result size.
 *
 * We use an OAuth refresh token (single-user, long-lived) rather than a
 * service account so no Google Workspace admin is required.
 */

import { google } from "googleapis";
import type { Interval } from "./intervals";

export interface FreeBusyOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  calendarIds: string[];
  /** Inclusive start of the query window (UTC ms). */
  timeMinMs: number;
  /** Exclusive end of the query window (UTC ms). */
  timeMaxMs: number;
}

export interface FreeBusyResult {
  intervals: Interval[];
  /** Calendar ids that returned errors — we still fail closed on any. */
  erroredCalendarIds: string[];
}

/**
 * Query Google FreeBusy.
 *
 * Throws on transport-level errors. If a specific calendar has an error
 * in the response body (e.g. "notFound"), we return it in
 * `erroredCalendarIds` and the caller decides what to do.
 *
 * Important:
 *   - FreeBusy has a 5-calendar limit per request, so we batch calendars.
 *   - FreeBusy can reject very large time windows, so we also chunk time
 *     range requests into 60-day slices.
 */
export async function fetchFreeBusy(opts: FreeBusyOptions): Promise<FreeBusyResult> {
  const auth = new google.auth.OAuth2(opts.clientId, opts.clientSecret);
  auth.setCredentials({ refresh_token: opts.refreshToken });
  const calendar = google.calendar({ version: "v3", auth });

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
