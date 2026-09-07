import { describe, expect, it } from "vitest";
import {
  buildSanitizedBoardWindowPayload,
  type BoardWindowQuery,
} from "@/lib/board-window";

/**
 * The board payload must carry `ownerEditor` for signed-in editors.
 *
 * DayBoard/MonthBoard re-derive edit + notes permission on the client
 * (`canManageDetailForEditor`), and for an ownership-scoped profile such as
 * milos that check is `ownerEditor === editorId`. When the server omitted the
 * field the client predicate could never be satisfied, so an own-scope editor
 * saw no location on their own gigs — and, because the edit modal hydrates
 * `bookingLocation` from the same predicate, saving that gig wrote
 * `location: ""` back to Google Calendar and erased the real location.
 */

const env = {
  GOOGLE_CALENDAR_ID: "la-jobs@group.calendar.google.com",
  OVERTURE_CALENDAR_ID: "overture@group.calendar.google.com",
};

const file = {
  timezone: "America/New_York",
  workdayStartHour: 9,
  workdayEndHour: 18,
};

const LA_LOCATION = "Chase Center on the Riverfront, Wilmington, DE";

const snapshot = {
  version: 1 as const,
  generatedAtUtc: "2026-05-01T12:00:00.000Z",
  windowStartUtc: "2026-05-01T00:00:00.000Z",
  windowEndUtc: "2026-08-01T00:00:00.000Z",
  busy: [
    { startUtc: "2026-05-12T04:00:00.000Z", endUtc: "2026-05-13T04:00:00.000Z" },
    { startUtc: "2026-05-13T04:00:00.000Z", endUtc: "2026-05-14T04:00:00.000Z" },
  ],
  namedEvents: [
    {
      startUtc: "2026-05-12T04:00:00.000Z",
      endUtc: "2026-05-13T04:00:00.000Z",
      summary: "LA#10001 — Dave LA Job",
      eventId: "evt-la-dave",
      location: LA_LOCATION,
      ownerEditor: "dave",
      calendarId: "la-jobs@group.calendar.google.com",
      displayMode: "details" as const,
    },
    {
      startUtc: "2026-05-13T04:00:00.000Z",
      endUtc: "2026-05-14T04:00:00.000Z",
      summary: "LA#10002 — Milos LA Job",
      eventId: "evt-la-milos",
      location: LA_LOCATION,
      ownerEditor: "milos",
      calendarId: "la-jobs@group.calendar.google.com",
      displayMode: "details" as const,
    },
  ],
  sourceCalendarIds: ["la-jobs@group.calendar.google.com"],
  config: {
    timezone: "America/New_York",
    workdayStartHour: 9,
    workdayEndHour: 18,
    hideWeekends: false,
    showTentative: false,
    pageTitle: "LA Schedule",
  },
};

const query: BoardWindowQuery = {
  viewMode: "list",
  requestedWeek: null,
  requestedMonth: null,
  weeksBefore: 0,
  weeksAfter: 8,
  monthsBefore: 0,
  monthsAfter: 4,
  scope: "full",
};

function buildFor(resolvedEditorId: string | null) {
  return buildSanitizedBoardWindowPayload({
    snapshot,
    snapshotStatus: "ok",
    file,
    env,
    query,
    resolvedEditorId,
    nowMs: Date.parse("2026-05-01T12:00:00.000Z"),
  });
}

/** Collects every event-detail object in the payload. */
function collectDetails(value: unknown, out: Record<string, unknown>[] = []) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectDetails(entry, out));
    return out;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.summary === "string" && (record.startUtc || record.startDate)) {
      out.push(record);
    }
    Object.values(record).forEach((entry) => collectDetails(entry, out));
  }
  return out;
}

function detailsFor(resolvedEditorId: string | null, summary: string) {
  return collectDetails(buildFor(resolvedEditorId)).filter((d) => d.summary === summary);
}

describe("board window ownerEditor exposure", () => {
  it("sends ownerEditor to an own-scope editor so their own location renders", () => {
    const details = detailsFor("milos", "LA#10002 — Milos LA Job");
    expect(details.length).toBeGreaterThan(0);
    for (const detail of details) {
      expect(detail.ownerEditor).toBe("milos");
      expect(detail.location).toBe(LA_LOCATION);
      // The client also requires eventId before it will treat a detail as
      // manageable; without it the location stays hidden.
      expect(detail.eventId).toBe("evt-la-milos");
    }
  });

  it("still withholds another editor's location from an own-scope editor", () => {
    const details = detailsFor("milos", "LA#10001 — Dave LA Job");
    expect(details.length).toBeGreaterThan(0);
    for (const detail of details) {
      expect(detail.location).toBeUndefined();
    }
  });

  it("sends ownerEditor and location for a calendar-scope editor (dave)", () => {
    const details = detailsFor("dave", "LA#10001 — Dave LA Job");
    expect(details.length).toBeGreaterThan(0);
    for (const detail of details) {
      expect(detail.ownerEditor).toBe("dave");
      expect(detail.location).toBe(LA_LOCATION);
    }
  });

  it("never exposes ownerEditor or location to anonymous viewers", () => {
    const details = collectDetails(buildFor(null));
    expect(details.length).toBeGreaterThan(0);
    for (const detail of details) {
      expect(detail.ownerEditor).toBeUndefined();
      expect(detail.location).toBeUndefined();
    }
  });
});
