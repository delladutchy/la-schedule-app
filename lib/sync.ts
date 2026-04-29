/**
 * Snapshot builder.
 *
 * Pipeline:
 *   1. Pull FreeBusy for all configured blocker calendars.
 *   2. Convert to internal Interval[].
 *   3. Apply pre/post buffers.
 *   4. Merge overlaps & adjacent blocks deterministically.
 *   5. Clip to the projection window.
 *   6. Optionally fetch event summaries for internal schedule labels.
 *   7. Produce a validated Snapshot.
 *
 * If ANY calendar errored in FreeBusy, we abort and do NOT write a new
 * snapshot. The old one stays in place. This is fail-closed behavior:
 * better to be slightly stale than to show free time that might be busy
 * on a calendar we couldn't read.
 */

import { applyBuffers } from "./intervals";
import { fetchFreeBusy, fetchCalendarEvents } from "./google";
import { getConfig } from "./config";
import { writeCurrentSnapshot } from "./store";
import type { BusyBlock, Snapshot, NamedEvent } from "./types";
import { DateTime } from "luxon";

export interface BuildResult {
  status: "ok" | "failed";
  snapshot?: Snapshot;
  error?: string;
  erroredCalendarIds?: string[];
}

export async function buildAndPersistSnapshot(
  nowMs: number = Date.now(),
): Promise<BuildResult> {
  const syncStartedAt = Date.now();
  const { file, env } = getConfig();

  // Window: from start of today in display zone, extending horizonDays forward.
  const startOfToday = DateTime.fromMillis(nowMs, { zone: "utc" })
    .setZone(file.timezone)
    .startOf("day");
  const windowStartMs = startOfToday.toUTC().toMillis();
  const windowEndMs = startOfToday.plus({ days: file.horizonDays }).toUTC().toMillis();

  const freeBusyStartedAt = Date.now();
  const freeBusyPromise = fetchFreeBusy({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    refreshToken: env.GOOGLE_REFRESH_TOKEN,
    calendarIds: env.BLOCKER_CALENDAR_IDS,
    timeMinMs: windowStartMs,
    timeMaxMs: windowEndMs,
  });
  const namedEventsStartedAt = Date.now();
  const namedEventsPromise = fetchCalendarEvents({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    refreshToken: env.GOOGLE_REFRESH_TOKEN,
    calendarIds: env.BLOCKER_CALENDAR_IDS,
    timeMinMs: windowStartMs,
    timeMaxMs: windowEndMs,
    displayTimezone: file.timezone,
  });

  const [freeBusyResult, namedEventsResult] = await Promise.allSettled([
    freeBusyPromise,
    namedEventsPromise,
  ]);
  const freeBusyDurationMs = Date.now() - freeBusyStartedAt;
  const namedEventsDurationMs = Date.now() - namedEventsStartedAt;

  if (freeBusyResult.status === "rejected") {
    const msg = freeBusyResult.reason instanceof Error
      ? freeBusyResult.reason.message
      : String(freeBusyResult.reason);
    console.error("[sync] freebusy transport error:", msg);
    console.info(`[sync] timings ms freebusy=${freeBusyDurationMs} namedEvents=${namedEventsDurationMs} total=${Date.now() - syncStartedAt}`);
    return { status: "failed", error: `FreeBusy transport error: ${msg}` };
  }
  const fb = freeBusyResult.value;

  if (fb.erroredCalendarIds.length > 0) {
    console.error("[sync] freebusy per-calendar errors:", fb.erroredCalendarIds);
    console.info(`[sync] timings ms freebusy=${freeBusyDurationMs} namedEvents=${namedEventsDurationMs} total=${Date.now() - syncStartedAt}`);
    return {
      status: "failed",
      error: "One or more calendars errored in FreeBusy response",
      erroredCalendarIds: fb.erroredCalendarIds,
    };
  }

  // Apply buffers + merge.
  const preMs = file.preBufferMinutes * 60 * 1000;
  const postMs = file.postBufferMinutes * 60 * 1000;
  const merged = applyBuffers(fb.intervals, preMs, postMs);

  // Clip to the projection window (buffers can extend outside it).
  const clipped = merged
    .map((i) => ({
      startMs: Math.max(i.startMs, windowStartMs),
      endMs: Math.min(i.endMs, windowEndMs),
      tentative: i.tentative,
    }))
    .filter((i) => i.endMs > i.startMs);

  const busy: BusyBlock[] = clipped.map((i) => ({
    startUtc: new Date(i.startMs).toISOString(),
    endUtc: new Date(i.endMs).toISOString(),
    ...(i.tentative ? { tentative: true } : {}),
  }));

  // Best-effort event-name fetch for internal schedule rendering.
  // We intentionally do not fail snapshot writes on title fetch errors,
  // so existing booked/available behavior remains reliable.
  let namedEvents: NamedEvent[] | undefined;
  if (namedEventsResult.status === "fulfilled") {
    const names = namedEventsResult.value;

    if (names.erroredCalendarIds.length > 0) {
      console.error("[sync] events per-calendar errors (continuing without names):", names.erroredCalendarIds);
    } else {
      namedEvents = names.events
        .map((event) => ({
          startMs: Math.max(event.startMs, windowStartMs),
          endMs: Math.min(event.endMs, windowEndMs),
          summary: event.summary.trim(),
          eventId: event.eventId?.trim(),
          description: event.description,
          ownerEditor: event.ownerEditor,
          calendarId: event.calendarId,
          displayMode: env.CALENDAR_DISPLAY_MODES[event.calendarId] ?? "details",
        }))
        .filter((event) => event.summary.length > 0 && event.endMs > event.startMs)
        .map((event) => ({
          startUtc: new Date(event.startMs).toISOString(),
          endUtc: new Date(event.endMs).toISOString(),
          summary: event.displayMode === "private" ? "Unavailable" : event.summary,
          ...(event.displayMode === "details" && event.eventId
            ? { eventId: event.eventId }
            : {}),
          ...(event.displayMode === "details" && event.description
            ? { description: event.description }
            : {}),
          ...(event.displayMode === "details" && event.ownerEditor
            ? { ownerEditor: event.ownerEditor }
            : {}),
          calendarId: event.calendarId,
          displayMode: event.displayMode,
        }));
    }
  } else {
    const msg = namedEventsResult.reason instanceof Error
      ? namedEventsResult.reason.message
      : String(namedEventsResult.reason);
    console.error("[sync] events transport error (continuing without names):", msg);
  }

  const snapshot: Snapshot = {
    version: 1,
    generatedAtUtc: new Date(nowMs).toISOString(),
    windowStartUtc: new Date(windowStartMs).toISOString(),
    windowEndUtc: new Date(windowEndMs).toISOString(),
    busy,
    ...(namedEvents && namedEvents.length > 0 ? { namedEvents } : {}),
    sourceCalendarIds: env.BLOCKER_CALENDAR_IDS,
    config: {
      timezone: file.timezone,
      workdayStartHour: file.workdayStartHour,
      workdayEndHour: file.workdayEndHour,
      hideWeekends: file.hideWeekends,
      showTentative: file.showTentative,
      pageTitle: file.pageTitle,
      pageSubtitle: file.pageSubtitle,
    },
  };

  try {
    const writeStartedAt = Date.now();
    await writeCurrentSnapshot(env.BLOBS_STORE_NAME, snapshot);
    console.info(`[sync] timings ms freebusy=${freeBusyDurationMs} namedEvents=${namedEventsDurationMs} write=${Date.now() - writeStartedAt} total=${Date.now() - syncStartedAt}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[sync] snapshot write failed:", msg);
    console.info(`[sync] timings ms freebusy=${freeBusyDurationMs} namedEvents=${namedEventsDurationMs} total=${Date.now() - syncStartedAt}`);
    return { status: "failed", error: `Snapshot write failed: ${msg}` };
  }

  return { status: "ok", snapshot };
}
