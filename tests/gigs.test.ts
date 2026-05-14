import { describe, expect, it } from "vitest";
import type { Snapshot } from "@/lib/types";
import {
  GigCreateBodySchema,
  resolveAllDayRange,
  buildLaJobSummary,
  parseLaJobSummary,
  parseGigDescription,
  buildGigDescription,
  buildGigDayDetailsForRange,
  resolveParsedGigDetailForDate,
  enumerateIsoDatesInRange,
  mergeGigDescriptionWithDailyDetailsBlock,
  APP_DAILY_DETAILS_BLOCK_START,
  APP_DAILY_DETAILS_BLOCK_END,
  isDateRangeAvailableInSnapshot,
  isDateRangeAvailableForEditInSnapshot,
} from "@/lib/gigs";
import { buildAllDayGigEventId } from "@/lib/gig-ids";

function makeSnapshot(partial: Partial<Snapshot> = {}): Snapshot {
  return {
    version: 1,
    generatedAtUtc: "2026-04-20T17:00:00.000Z",
    windowStartUtc: "2026-04-20T04:00:00.000Z",
    windowEndUtc: "2026-05-20T04:00:00.000Z",
    busy: [],
    sourceCalendarIds: ["primary"],
    config: {
      timezone: "America/New_York",
      workdayStartHour: 9,
      workdayEndHour: 18,
      hideWeekends: false,
      showTentative: false,
      pageTitle: "Availability",
    },
    ...partial,
  };
}

describe("GigCreateBodySchema", () => {
  it("accepts single-date all-day payload", () => {
    const parsed = GigCreateBodySchema.safeParse({
      summary: "LA#71411 Wilmington Flower Market",
      date: "2026-05-06",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts ranged all-day payload", () => {
    const parsed = GigCreateBodySchema.safeParse({
      summary: "Desert",
      startDate: "2026-04-30",
      endDate: "2026-05-03",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects mixed single + range payload", () => {
    const parsed = GigCreateBodySchema.safeParse({
      summary: "Bad payload",
      date: "2026-05-06",
      startDate: "2026-05-06",
      endDate: "2026-05-07",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("resolveAllDayRange", () => {
  it("converts single date to end-exclusive range", () => {
    const out = resolveAllDayRange({
      summary: "Gig",
      date: "2026-05-08",
    });
    expect(out).toEqual({
      startDate: "2026-05-08",
      endDateInclusive: "2026-05-08",
      endDateExclusive: "2026-05-09",
    });
  });

  it("converts inclusive range to end-exclusive range", () => {
    const out = resolveAllDayRange({
      summary: "Gig",
      startDate: "2026-05-06",
      endDate: "2026-05-07",
    });
    expect(out).toEqual({
      startDate: "2026-05-06",
      endDateInclusive: "2026-05-07",
      endDateExclusive: "2026-05-08",
    });
  });
});

describe("buildAllDayGigEventId", () => {
  it("is deterministic by calendar + date range", () => {
    const a = buildAllDayGigEventId("primary", "2026-05-06", "2026-05-07");
    const b = buildAllDayGigEventId("primary", "2026-05-06", "2026-05-07");
    const c = buildAllDayGigEventId("primary", "2026-05-07", "2026-05-07");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("contains only lowercase alphanumeric characters", () => {
    const id = buildAllDayGigEventId(
      "fakecalendarid1234567890abcdef@group.calendar.google.com",
      "2026-05-06",
      "2026-05-07",
    );
    expect(id).toMatch(/^[a-z0-9]+$/);
  });

  it("stays at a safe fixed length", () => {
    const id = buildAllDayGigEventId("primary", "2026-05-06", "2026-05-07");
    expect(id.length).toBe(41);
    expect(id.length).toBeLessThanOrEqual(128);
  });
});

describe("buildLaJobSummary", () => {
  it("builds a normalized LA job summary", () => {
    expect(buildLaJobSummary("71411", "Wilmington Flower Market"))
      .toBe("LA#71411 — Wilmington Flower Market");
  });

  it("allows blank LA # and returns job name only", () => {
    expect(buildLaJobSummary("   ", "Wilmington Flower Market"))
      .toBe("Wilmington Flower Market");
  });

  it("rejects non-numeric LA #", () => {
    expect(() => buildLaJobSummary("71A11", "Wilmington Flower Market"))
      .toThrow("LA # must be numbers only.");
  });

  it("rejects empty job name", () => {
    expect(() => buildLaJobSummary("71411", "   "))
      .toThrow("Job Name is required.");
  });
});

describe("parseLaJobSummary", () => {
  it("extracts LA job number and remaining title", () => {
    expect(parseLaJobSummary("LA#71411 — Wilmington Flower Market")).toEqual({
      jobNumber: "LA#71411",
      jobName: "Wilmington Flower Market",
    });
  });

  it("keeps raw title when no LA number exists", () => {
    expect(parseLaJobSummary("Desert")).toEqual({
      jobName: "Desert",
    });
  });
});

describe("parseGigDescription/buildGigDescription", () => {
  it("round-trips call time and notes", () => {
    const built = buildGigDescription("8:00 AM", "Venue loading at north dock");
    expect(built).toContain(APP_DAILY_DETAILS_BLOCK_START);
    expect(parseGigDescription(built)).toEqual({
      callTime: "8:00 AM",
      jobNotes: "Venue loading at north dock",
    });
    expect(parseGigDescription(built).dayDetails).toBeUndefined();
  });

  it("omits empty lines and parses multi-line notes", () => {
    const parsed = parseGigDescription("Call Time: TBD\nJob Notes: First line\nSecond line");
    expect(parsed).toEqual({
      callTime: "TBD",
      jobNotes: "First line\nSecond line",
    });
  });

  it("supports per-day start time and notes details", () => {
    const built = buildGigDescription(
      "8:00 AM",
      "Global notes",
      [
        { date: "2026-05-28", startTime: "8:00 AM" },
        { date: "2026-05-29", startTime: "9:00 AM", notes: "Load-in at side door" },
      ],
    );
    expect(built).toContain(APP_DAILY_DETAILS_BLOCK_START);
    const parsed = parseGigDescription(built);
    expect(parsed.dayDetails).toEqual({
      "2026-05-28": { startTime: "8:00 AM" },
      "2026-05-29": { startTime: "9:00 AM", notes: "Load-in at side door" },
    });
    expect(resolveParsedGigDetailForDate(parsed, "2026-05-28")).toEqual({
      startTime: "8:00 AM",
      notes: "Global notes",
    });
    expect(resolveParsedGigDetailForDate(parsed, "2026-05-29")).toEqual({
      startTime: "9:00 AM",
      notes: "Load-in at side door",
    });
  });

  it("parses legacy human description format when app block is absent", () => {
    const parsed = parseGigDescription("Call Time: 9:00 AM\nJob Notes: Bring radios");
    expect(parsed).toEqual({
      callTime: "9:00 AM",
      jobNotes: "Bring radios",
    });
  });

  it("never leaks raw block markers into jobNotes when JSON is invalid", () => {
    const malformed = `${APP_DAILY_DETAILS_BLOCK_START}\n{not json}\n${APP_DAILY_DETAILS_BLOCK_END}`;
    const parsed = parseGigDescription(malformed);
    expect(parsed.jobNotes).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain(APP_DAILY_DETAILS_BLOCK_START);
    expect(JSON.stringify(parsed)).not.toContain(APP_DAILY_DETAILS_BLOCK_END);
  });

  it("never leaks raw block markers into jobNotes when END marker is missing", () => {
    const truncated = `Human notes here\n${APP_DAILY_DETAILS_BLOCK_START}\n{"callTime":"8:00 AM"}`;
    const parsed = parseGigDescription(truncated);
    expect(parsed.jobNotes).toBe("Human notes here");
    expect(JSON.stringify(parsed)).not.toContain(APP_DAILY_DETAILS_BLOCK_START);
  });

  it("never leaks raw block markers into jobNotes in a double-START description", () => {
    // Scenario: malformed block from an earlier state was appended-to rather than
    // replaced, creating two START markers with only one END marker.
    const doubleStart = [
      APP_DAILY_DETAILS_BLOCK_START,
      "{bad json from old state}",
      APP_DAILY_DETAILS_BLOCK_START,
      JSON.stringify({ callTime: "8:00 AM" }, null, 2),
      APP_DAILY_DETAILS_BLOCK_END,
    ].join("\n");
    const parsed = parseGigDescription(doubleStart);
    expect(JSON.stringify(parsed)).not.toContain(APP_DAILY_DETAILS_BLOCK_START);
    expect(JSON.stringify(parsed)).not.toContain(APP_DAILY_DETAILS_BLOCK_END);
    expect(parsed.jobNotes).toBeUndefined();
  });

  it("preserves human text outside block when END marker is missing", () => {
    const truncated = `Notes: bring cables\n${APP_DAILY_DETAILS_BLOCK_START}\n{"callTime":"TBD"}`;
    const parsed = parseGigDescription(truncated);
    expect(parsed.jobNotes).toContain("Notes: bring cables");
    expect(JSON.stringify(parsed)).not.toContain(APP_DAILY_DETAILS_BLOCK_START);
  });

  it("round-trips jobTitle for Overture events", () => {
    const built = buildGigDescription("TBD", undefined, [], "Fancy Gig Name");
    expect(built).toContain(APP_DAILY_DETAILS_BLOCK_START);
    const parsed = parseGigDescription(built);
    expect(parsed.jobTitle).toBe("Fancy Gig Name");
    expect(parsed.callTime).toBe("TBD");
    expect(parsed.jobNotes).toBeUndefined();
  });

  it("omits jobTitle from payload when not provided", () => {
    const built = buildGigDescription("8:00 AM", "Notes only");
    const parsed = parseGigDescription(built);
    expect(parsed.jobTitle).toBeUndefined();
  });

  it("round-trips jobTitle alongside dayDetails", () => {
    const built = buildGigDescription(
      "TBD",
      "Overall notes",
      [{ date: "2026-06-01", startTime: "7:00 AM", notes: "Load-in early" }],
      "My Event",
    );
    const parsed = parseGigDescription(built);
    expect(parsed.jobTitle).toBe("My Event");
    expect(parsed.dayDetails?.["2026-06-01"]?.startTime).toBe("7:00 AM");
    expect(parsed.jobNotes).toBe("Overall notes");
  });
});

describe("mergeGigDescriptionWithDailyDetailsBlock", () => {
  it("preserves legacy single-day description metadata without adding day details", () => {
    const original = "Human notes stay exactly here.";
    const merged = mergeGigDescriptionWithDailyDetailsBlock(original, {
      callTime: "8:00 AM",
      jobNotes: "Venue loading at north dock",
    });
    expect(merged?.startsWith(original)).toBe(true);
    const parsed = parseGigDescription(merged ?? "");
    expect(parsed.callTime).toBe("8:00 AM");
    expect(parsed.jobNotes).toBe("Venue loading at north dock");
    expect(parsed.dayDetails).toBeUndefined();
  });

  it("preserves human-written description verbatim and appends block when none exists", () => {
    const human = "Line 1\nLine 2\nCall producer at 7.";
    const merged = mergeGigDescriptionWithDailyDetailsBlock(human, {
      callTime: "8:00 AM",
      jobNotes: "Bring radios",
      dayDetails: [{ date: "2026-05-29", startTime: "8:00 AM" }],
    });
    expect(merged?.startsWith(human)).toBe(true);
    expect(merged).toContain(APP_DAILY_DETAILS_BLOCK_START);
  });

  it("replaces only app-owned block and keeps surrounding text exactly", () => {
    const original = [
      "HUMAN TOP",
      APP_DAILY_DETAILS_BLOCK_START,
      JSON.stringify({ callTime: "8:00 AM" }, null, 2),
      APP_DAILY_DETAILS_BLOCK_END,
      "HUMAN BOTTOM",
    ].join("\n");
    const merged = mergeGigDescriptionWithDailyDetailsBlock(original, {
      callTime: "9:00 AM",
    });
    expect(merged).toContain("HUMAN TOP");
    expect(merged).toContain("HUMAN BOTTOM");
    expect(merged).toContain("\"callTime\": \"9:00 AM\"");
    expect(merged).not.toContain("\"callTime\": \"8:00 AM\"");
  });

  it("does not delete malformed block content and appends a new safe block", () => {
    const malformed = `Human notes\n${APP_DAILY_DETAILS_BLOCK_START}\n{bad json`;
    const merged = mergeGigDescriptionWithDailyDetailsBlock(malformed, {
      callTime: "10:00 AM",
    });
    expect(merged).toContain(malformed);
    expect(merged).toContain(APP_DAILY_DETAILS_BLOCK_START);
    expect(merged?.indexOf(APP_DAILY_DETAILS_BLOCK_START)).toBeLessThan(
      merged?.lastIndexOf(APP_DAILY_DETAILS_BLOCK_START) ?? -1,
    );
  });

  it("preserves jobTitle through merge round-trip", () => {
    const original = [
      APP_DAILY_DETAILS_BLOCK_START,
      JSON.stringify({ callTime: "TBD", jobTitle: "Old Title" }, null, 2),
      APP_DAILY_DETAILS_BLOCK_END,
    ].join("\n");
    const merged = mergeGigDescriptionWithDailyDetailsBlock(original, {
      callTime: "8:00 AM",
      jobTitle: "New Title",
    });
    const parsed = parseGigDescription(merged ?? "");
    expect(parsed.jobTitle).toBe("New Title");
    expect(parsed.callTime).toBe("8:00 AM");
  });
});

describe("buildGigDayDetailsForRange", () => {
  it("creates daily rows for each date in range", () => {
    expect(enumerateIsoDatesInRange("2026-05-28", "2026-05-30")).toEqual([
      "2026-05-28",
      "2026-05-29",
      "2026-05-30",
    ]);
  });

  it("applies default start time to all selected days", () => {
    const out = buildGigDayDetailsForRange({
      startDate: "2026-05-28",
      endDateInclusive: "2026-05-30",
      defaultStartTime: "8:00 AM",
    });
    expect(out.map((row) => row.startTime)).toEqual(["8:00 AM", "8:00 AM", "8:00 AM"]);
  });

  it("preserves per-day start time override", () => {
    const out = buildGigDayDetailsForRange({
      startDate: "2026-05-28",
      endDateInclusive: "2026-05-30",
      defaultStartTime: "8:00 AM",
      overrides: [{ date: "2026-05-29", startTime: "9:00 AM" }],
    });
    expect(out).toEqual([
      { date: "2026-05-28", startTime: "8:00 AM" },
      { date: "2026-05-29", startTime: "9:00 AM" },
      { date: "2026-05-30", startTime: "8:00 AM" },
    ]);
  });
});

describe("isDateRangeAvailableInSnapshot", () => {
  it("returns false when busy overlaps any day in range", () => {
    const snapshot = makeSnapshot({
      busy: [
        {
          startUtc: "2026-05-07T14:00:00.000Z",
          endUtc: "2026-05-07T16:00:00.000Z",
        },
      ],
    });

    const out = isDateRangeAvailableInSnapshot(
      snapshot,
      "America/New_York",
      "2026-05-06",
      "2026-05-08",
    );
    expect(out).toBe(false);
  });

  it("returns true when no day in range overlaps busy", () => {
    const snapshot = makeSnapshot({
      busy: [
        {
          startUtc: "2026-05-10T14:00:00.000Z",
          endUtc: "2026-05-10T16:00:00.000Z",
        },
      ],
    });

    const out = isDateRangeAvailableInSnapshot(
      snapshot,
      "America/New_York",
      "2026-05-06",
      "2026-05-08",
    );
    expect(out).toBe(true);
  });
});

describe("isDateRangeAvailableForEditInSnapshot", () => {
  const editorCalendarId = "la-jobs@group.calendar.google.com";
  const editableEventId = "event-edit-1";

  it("allows overlap with the same editable event id", () => {
    const snapshot = makeSnapshot({
      busy: [
        {
          startUtc: "2026-05-07T04:00:00.000Z",
          endUtc: "2026-05-08T04:00:00.000Z",
        },
      ],
      namedEvents: [
        {
          startUtc: "2026-05-07T04:00:00.000Z",
          endUtc: "2026-05-08T04:00:00.000Z",
          summary: "LA#71411 — Wilmington Flower Market",
          eventId: editableEventId,
          calendarId: editorCalendarId,
          displayMode: "details",
        },
      ],
    });

    const out = isDateRangeAvailableForEditInSnapshot(
      snapshot,
      "America/New_York",
      "2026-05-07",
      "2026-05-07",
      { eventId: editableEventId, editorCalendarId },
    );
    expect(out).toBe(true);
  });

  it("blocks overlap with a different event id", () => {
    const snapshot = makeSnapshot({
      busy: [
        {
          startUtc: "2026-05-07T04:00:00.000Z",
          endUtc: "2026-05-08T04:00:00.000Z",
        },
      ],
      namedEvents: [
        {
          startUtc: "2026-05-07T04:00:00.000Z",
          endUtc: "2026-05-08T04:00:00.000Z",
          summary: "LA#77777 — Another Job",
          eventId: "event-other-2",
          calendarId: editorCalendarId,
          displayMode: "details",
        },
      ],
    });

    const out = isDateRangeAvailableForEditInSnapshot(
      snapshot,
      "America/New_York",
      "2026-05-07",
      "2026-05-07",
      { eventId: editableEventId, editorCalendarId },
    );
    expect(out).toBe(false);
  });

  it("blocks overlap from private calendar events", () => {
    const snapshot = makeSnapshot({
      busy: [
        {
          startUtc: "2026-05-07T04:00:00.000Z",
          endUtc: "2026-05-08T04:00:00.000Z",
        },
      ],
      namedEvents: [
        {
          startUtc: "2026-05-07T04:00:00.000Z",
          endUtc: "2026-05-08T04:00:00.000Z",
          summary: "Unavailable",
          calendarId: "private-calendar@group.calendar.google.com",
          displayMode: "private",
        },
      ],
    });

    const out = isDateRangeAvailableForEditInSnapshot(
      snapshot,
      "America/New_York",
      "2026-05-07",
      "2026-05-07",
      { eventId: editableEventId, editorCalendarId },
    );
    expect(out).toBe(false);
  });

  it("fails closed on unknown busy overlap with no named event mapping", () => {
    const snapshot = makeSnapshot({
      busy: [
        {
          startUtc: "2026-05-07T04:00:00.000Z",
          endUtc: "2026-05-08T04:00:00.000Z",
        },
      ],
    });

    const out = isDateRangeAvailableForEditInSnapshot(
      snapshot,
      "America/New_York",
      "2026-05-07",
      "2026-05-07",
      { eventId: editableEventId, editorCalendarId },
    );
    expect(out).toBe(false);
  });
});
