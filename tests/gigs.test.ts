import { describe, expect, it } from "vitest";
import type { Snapshot } from "@/lib/types";
import {
  GigCreateBodySchema,
  resolveAllDayRange,
  buildLaJobSummary,
  parseLaJobSummary,
  parseGigDescription,
  buildGigDescription,
  isDateRangeAvailableInSnapshot,
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

  it("rejects non-numeric LA #", () => {
    expect(() => buildLaJobSummary("71A11", "Wilmington Flower Market"))
      .toThrow("LA # is required and must be numbers only.");
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
    expect(built).toBe("Call Time: 8:00 AM\nJob Notes: Venue loading at north dock");
    expect(parseGigDescription(built)).toEqual({
      callTime: "8:00 AM",
      jobNotes: "Venue loading at north dock",
    });
  });

  it("omits empty lines and parses multi-line notes", () => {
    const parsed = parseGigDescription("Call Time: TBD\nJob Notes: First line\nSecond line");
    expect(parsed).toEqual({
      callTime: "TBD",
      jobNotes: "First line\nSecond line",
    });
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
