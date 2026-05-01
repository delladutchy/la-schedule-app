import { describe, it, expect } from "vitest";
import type { DayStatus, Snapshot } from "@/lib/types";
import { filterWeekRowsByWeekendVisibility } from "@/components/DayBoard";
import {
  filterMonthWeeksForVisibleCurrentMonthDays,
  clipBarToVisibleDayIndexes,
  monthBarGridStyle,
  resolveVisibleDayIndexes,
} from "@/components/MonthBoard";
import {
  classifySnapshot,
  buildDayBoard,
  trimWeekRowsForScheduleList,
  resolveWeekNavigation,
  buildMonthBoard,
  resolveMonthNavigation,
  buildWeekConnectorParts,
  connectorKeyForDay,
  summarizeBookedDayLabel,
} from "@/lib/view";

function makeSnapshot(partial: Partial<Snapshot> = {}): Snapshot {
  return {
    version: 1,
    // Mon 2026-04-20 17:00 UTC = 1pm America/New_York
    generatedAtUtc: "2026-04-20T17:00:00.000Z",
    windowStartUtc: "2026-04-20T04:00:00.000Z",
    windowEndUtc: "2026-05-04T04:00:00.000Z",
    busy: [],
    sourceCalendarIds: ["primary"],
    config: {
      timezone: "America/New_York",
      workdayStartHour: 9,
      workdayEndHour: 18,
      hideWeekends: true,
      showTentative: false,
      pageTitle: "Availability",
    },
    ...partial,
  };
}

// --------- Freshness gate (unchanged behavior) ---------

describe("classifySnapshot — freshness gate", () => {
  const NOW = Date.parse("2026-04-20T17:00:00.000Z");

  it("returns unavailable when snapshot is null", () => {
    const s = classifySnapshot(null, NOW, { freshTtlMinutes: 30, hardTtlMinutes: 180 });
    expect(s.status).toBe("unavailable");
    expect(s.snapshot).toBeNull();
  });

  it("returns ok when snapshot is within freshTtl", () => {
    const snap = makeSnapshot({ generatedAtUtc: "2026-04-20T16:50:00.000Z" }); // 10 min ago
    const s = classifySnapshot(snap, NOW, { freshTtlMinutes: 30, hardTtlMinutes: 180 });
    expect(s.status).toBe("ok");
    expect(s.ageMinutes).toBeCloseTo(10, 1);
  });

  it("returns stale between freshTtl and hardTtl", () => {
    const snap = makeSnapshot({ generatedAtUtc: "2026-04-20T16:00:00.000Z" });
    const s = classifySnapshot(snap, NOW, { freshTtlMinutes: 30, hardTtlMinutes: 180 });
    expect(s.status).toBe("stale");
    expect(s.snapshot).toBe(snap);
  });

  it("returns unavailable beyond hardTtl (FAIL CLOSED)", () => {
    const snap = makeSnapshot({ generatedAtUtc: "2026-04-20T13:00:00.000Z" });
    const s = classifySnapshot(snap, NOW, { freshTtlMinutes: 30, hardTtlMinutes: 180 });
    expect(s.status).toBe("unavailable");
    expect(s.snapshot).toBeNull();
  });
});

describe("month row-span rendering geometry", () => {
  it("maps a multi-day segment to one row-level grid span", () => {
    expect(monthBarGridStyle(3, 6, 0)).toEqual({
      gridColumn: "4 / 8",
      gridRow: "1",
    });
  });

  it("maps a single-day segment to one grid column", () => {
    expect(monthBarGridStyle(2, 2, 1)).toEqual({
      gridColumn: "3 / 4",
      gridRow: "2",
    });
  });
});

describe("weekend visibility helpers", () => {
  it("filters weekend days from week rows and drops empty weeks when hidden", () => {
    const weeks = [
      {
        weekOf: "2026-05-04",
        label: "Week of May 4",
        days: [
          { date: "2026-05-09", label: "Saturday, May 9", isToday: false, isWeekend: true, status: "available" as const },
          { date: "2026-05-10", label: "Sunday, May 10", isToday: true, isWeekend: true, status: "available" as const },
        ],
      },
      {
        weekOf: "2026-05-11",
        label: "Week of May 11",
        days: [
          { date: "2026-05-11", label: "Monday, May 11", isToday: false, isWeekend: false, status: "available" as const },
          { date: "2026-05-12", label: "Tuesday, May 12", isToday: false, isWeekend: false, status: "available" as const },
        ],
      },
    ];

    const hidden = filterWeekRowsByWeekendVisibility(weeks, true);
    expect(hidden).toHaveLength(1);
    expect(hidden[0]?.days.map((d) => d.date)).toEqual(["2026-05-11", "2026-05-12"]);

    const shown = filterWeekRowsByWeekendVisibility(weeks, false);
    expect(shown).toHaveLength(2);
    expect(shown[0]?.days).toHaveLength(2);
  });

  it("uses 5 visible day indexes when weekends are hidden", () => {
    expect(resolveVisibleDayIndexes(true)).toEqual([0, 1, 2, 3, 4]);
    expect(resolveVisibleDayIndexes(false)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("clips month bars against visible day indexes", () => {
    const weekdayIndexes = resolveVisibleDayIndexes(true);
    expect(clipBarToVisibleDayIndexes(4, 6, weekdayIndexes)).toEqual({
      startDayIndex: 4,
      endDayIndex: 4,
    });
    expect(clipBarToVisibleDayIndexes(5, 6, weekdayIndexes)).toBeNull();
    expect(clipBarToVisibleDayIndexes(1, 3, weekdayIndexes)).toEqual({
      startDayIndex: 1,
      endDayIndex: 3,
    });
  });

  it("drops month week rows that have zero current-month visible weekdays when weekends are hidden", () => {
    const weeks = [
      {
        days: [
          { isCurrentMonth: false },
          { isCurrentMonth: false },
          { isCurrentMonth: false },
          { isCurrentMonth: false },
          { isCurrentMonth: false },
          { isCurrentMonth: true },
          { isCurrentMonth: true },
        ],
        bars: [],
      },
      {
        days: [
          { isCurrentMonth: false },
          { isCurrentMonth: false },
          { isCurrentMonth: true },
          { isCurrentMonth: true },
          { isCurrentMonth: true },
          { isCurrentMonth: true },
          { isCurrentMonth: true },
        ],
        bars: [],
      },
    ] as unknown as Parameters<typeof filterMonthWeeksForVisibleCurrentMonthDays>[0];

    const weekdayIndexes = resolveVisibleDayIndexes(true);
    const filtered = filterMonthWeeksForVisibleCurrentMonthDays(weeks, weekdayIndexes, true);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toBe(weeks[1]);

    const unchanged = filterMonthWeeksForVisibleCurrentMonthDays(weeks, weekdayIndexes, false);
    expect(unchanged).toHaveLength(2);
  });
});

// --------- buildDayBoard ---------

describe("buildDayBoard — employer-facing day board", () => {
  // Monday April 20 2026 in America/New_York. We anchor on this.
  const START = "2026-04-20";
  const TZ = "America/New_York";

  const defaultOpts = {
    startDate: START,
    weeks: 1 as const,
    timezone: TZ,
    workdayStartHour: 9,
    workdayEndHour: 18,
  };

  it("shows 7 days (Mon–Sun) per week", () => {
    const snap = makeSnapshot();
    const weeks = buildDayBoard({ ...defaultOpts, snapshot: snap });
    expect(weeks).toHaveLength(1);
    expect(weeks[0]?.days).toHaveLength(7);
    const labels = weeks[0]?.days.map((d) => d.label) ?? [];
    expect(labels[0]).toMatch(/^Monday/);
    expect(labels[5]).toMatch(/^Saturday/);
    expect(labels[6]).toMatch(/^Sunday/);
  });

  it("marks an untouched weekday as Available", () => {
    const snap = makeSnapshot();
    const weeks = buildDayBoard({ ...defaultOpts, snapshot: snap });
    expect(weeks[0]?.days.every((d) => d.status === "available")).toBe(true);
  });

  it("marks a weekday Booked when ANY busy block overlaps the workday", () => {
    // Mon Apr 20 2026, 10:30–11:00am ET = 14:30–15:00 UTC
    const snap = makeSnapshot({
      busy: [{ startUtc: "2026-04-20T14:30:00.000Z", endUtc: "2026-04-20T15:00:00.000Z" }],
    });
    const weeks = buildDayBoard({ ...defaultOpts, snapshot: snap });
    expect(weeks[0]?.days[0]?.status).toBe("booked");
    expect(weeks[0]?.days[1]?.status).toBe("available");
  });

  it("marks a weekday Booked even for a short partial-day overlap", () => {
    // 15 minutes on Tuesday morning
    const snap = makeSnapshot({
      busy: [{ startUtc: "2026-04-21T13:15:00.000Z", endUtc: "2026-04-21T13:30:00.000Z" }],
    });
    const weeks = buildDayBoard({ ...defaultOpts, snapshot: snap });
    expect(weeks[0]?.days[1]?.status).toBe("booked");
  });

  it("marks a weekday Booked for an all-day event", () => {
    // All-day Wednesday in ET = midnight-to-midnight = 04:00 UTC to 04:00 UTC next day
    const snap = makeSnapshot({
      busy: [{ startUtc: "2026-04-22T04:00:00.000Z", endUtc: "2026-04-23T04:00:00.000Z" }],
    });
    const weeks = buildDayBoard({ ...defaultOpts, snapshot: snap });
    expect(weeks[0]?.days[2]?.status).toBe("booked");
    expect(weeks[0]?.days[0]?.status).toBe("available");
    expect(weeks[0]?.days[3]?.status).toBe("available");
  });

  it("marks every affected weekday Booked for a multi-day event", () => {
    const snap = makeSnapshot({
      busy: [{ startUtc: "2026-04-21T04:00:00.000Z", endUtc: "2026-04-24T04:00:00.000Z" }],
    });
    const weeks = buildDayBoard({ ...defaultOpts, snapshot: snap });
    // Mon available, Tue/Wed/Thu booked, Fri available
    expect(weeks[0]?.days[0]?.status).toBe("available");
    expect(weeks[0]?.days[1]?.status).toBe("booked");
    expect(weeks[0]?.days[2]?.status).toBe("booked");
    expect(weeks[0]?.days[3]?.status).toBe("booked");
    expect(weeks[0]?.days[4]?.status).toBe("available");
  });

  it("conservative: tentative events mark the day Booked", () => {
    const snap = makeSnapshot({
      busy: [{ startUtc: "2026-04-21T14:00:00.000Z", endUtc: "2026-04-21T15:00:00.000Z", tentative: true }],
    });
    const weeks = buildDayBoard({ ...defaultOpts, snapshot: snap });
    expect(weeks[0]?.days[1]?.status).toBe("booked");
  });

  it("attaches booked-day event names from snapshot namedEvents", () => {
    const snap = makeSnapshot({
      busy: [{ startUtc: "2026-04-21T13:00:00.000Z", endUtc: "2026-04-21T17:00:00.000Z" }],
      namedEvents: [
        { startUtc: "2026-04-21T13:00:00.000Z", endUtc: "2026-04-21T14:00:00.000Z", summary: "LA#71411 Wilmington Flower Market", calendarId: "jobs", displayMode: "details" },
        { startUtc: "2026-04-21T15:00:00.000Z", endUtc: "2026-04-21T16:00:00.000Z", summary: "LA#71760 Camden Yards", calendarId: "jobs", displayMode: "details" },
        { startUtc: "2026-04-21T15:15:00.000Z", endUtc: "2026-04-21T15:30:00.000Z", summary: "LA#71760 Camden Yards", calendarId: "jobs", displayMode: "details" },
      ],
    });

    const weeks = buildDayBoard({ ...defaultOpts, snapshot: snap });
    expect(weeks[0]?.days[1]?.status).toBe("booked");
    expect(weeks[0]?.days[1]?.eventNames).toEqual([
      "LA#71411 Wilmington Flower Market",
      "LA#71760 Camden Yards",
    ]);
    expect(weeks[0]?.days[0]?.eventNames).toBeUndefined();
  });

  it("attaches booked-day event details including date/time labels", () => {
    const snap = makeSnapshot({
      busy: [{ startUtc: "2026-04-21T13:30:00.000Z", endUtc: "2026-04-21T17:15:00.000Z" }],
      namedEvents: [
        { startUtc: "2026-04-21T13:30:00.000Z", endUtc: "2026-04-21T17:15:00.000Z", summary: "LA#70924 UD G", calendarId: "jobs", displayMode: "details" },
      ],
    });

    const weeks = buildDayBoard({ ...defaultOpts, snapshot: snap });
    const details = weeks[0]?.days[1]?.eventDetails;
    expect(details).toHaveLength(1);
    expect(details?.[0]?.summary).toBe("LA#70924 UD G");
    expect(details?.[0]?.dateRangeLabel).toBe("Apr 21");
    expect(details?.[0]?.timeRangeLabel).toContain("9:30 AM");
    expect(details?.[0]?.timeRangeLabel).toContain("1:15 PM");
    expect(details?.[0]?.displayMode).toBe("details");
  });

  it("preserves event descriptions in day detail rows", () => {
    const snap = makeSnapshot({
      busy: [{ startUtc: "2026-04-21T13:30:00.000Z", endUtc: "2026-04-21T17:15:00.000Z" }],
      namedEvents: [
        {
          startUtc: "2026-04-21T13:30:00.000Z",
          endUtc: "2026-04-21T17:15:00.000Z",
          summary: "Overture",
          description: "Call Time: 9:00 AM\nJob Notes: Bring wardrobe options",
          calendarId: "overture@group.calendar.google.com",
          displayMode: "details",
        },
      ],
    });

    const weeks = buildDayBoard({ ...defaultOpts, snapshot: snap });
    const details = weeks[0]?.days[1]?.eventDetails;
    expect(details?.[0]?.description).toBe("Call Time: 9:00 AM\nJob Notes: Bring wardrobe options");
    expect(details?.[0]?.calendarId).toBe("overture@group.calendar.google.com");
  });

  it("marks private-calendar days as private and hides private summaries", () => {
    const snap = makeSnapshot({
      busy: [{ startUtc: "2026-04-21T13:00:00.000Z", endUtc: "2026-04-21T17:00:00.000Z" }],
      namedEvents: [
        {
          startUtc: "2026-04-21T13:00:00.000Z",
          endUtc: "2026-04-21T17:00:00.000Z",
          summary: "Hawaii Vacation",
          calendarId: "personal@group.calendar.google.com",
          displayMode: "private",
        },
      ],
    });

    const weeks = buildDayBoard({ ...defaultOpts, snapshot: snap });
    const day = weeks[0]?.days[1];
    expect(day?.bookedDisplay).toBe("private");
    expect(day?.eventNames).toEqual(["Unavailable"]);
    expect(day?.eventDetails?.[0]?.summary).toBe("Unavailable");
    expect(day?.eventDetails?.[0]?.displayMode).toBe("private");
  });

  it("ignores busy blocks entirely outside the workday (e.g. evening)", () => {
    // Mon 8pm–9pm ET = 00:00–01:00 UTC next day
    const snap = makeSnapshot({
      busy: [{ startUtc: "2026-04-21T00:00:00.000Z", endUtc: "2026-04-21T01:00:00.000Z" }],
    });
    const weeks = buildDayBoard({ ...defaultOpts, snapshot: snap });
    // Monday workday ends at 6pm ET = 22:00 UTC; this block is 00:00-01:00 UTC = 8-9pm ET Mon
    // 8pm is after 6pm, so the workday does NOT overlap it → Monday stays available.
    expect(weeks[0]?.days[0]?.status).toBe("available");
  });

  it("shows 14 day rows across 2 weeks when weeks=2", () => {
    const snap = makeSnapshot();
    const weeks = buildDayBoard({ ...defaultOpts, snapshot: snap, weeks: 2 });
    expect(weeks).toHaveLength(2);
    expect(weeks[0]?.days).toHaveLength(7);
    expect(weeks[1]?.days).toHaveLength(7);
  });

  it("anchors correctly when startDate is a Wednesday (rolls back to Monday)", () => {
    const snap = makeSnapshot();
    // Wed Apr 22 2026 → should anchor to Mon Apr 20
    const weeks = buildDayBoard({
      ...defaultOpts,
      startDate: "2026-04-22",
      snapshot: snap,
    });
    expect(weeks[0]?.days[0]?.label).toMatch(/^Monday, Apr 20/);
  });

  it("respects the given timezone over the snapshot's embedded timezone", () => {
    // Snapshot says LA, caller asks for NY → NY should win.
    const snap = makeSnapshot({
      config: { ...makeSnapshot().config, timezone: "America/Los_Angeles" },
    });
    const weeks = buildDayBoard({ ...defaultOpts, snapshot: snap });
    // Just confirm we produced full week rows; the labels reflect NY calendar days.
    expect(weeks[0]?.days).toHaveLength(7);
    expect(weeks[0]?.days[0]?.label).toMatch(/^Monday/);
  });

  it("flags isToday correctly", () => {
    const snap = makeSnapshot();
    // NOW = Mon Apr 20 2026 12:00 UTC (8am ET) — still Monday in NY
    const nowMs = Date.parse("2026-04-20T12:00:00.000Z");
    const weeks = buildDayBoard({ ...defaultOpts, snapshot: snap, nowMs });
    expect(weeks[0]?.days[0]?.isToday).toBe(true);
    expect(weeks[0]?.days[1]?.isToday).toBe(false);
  });

  it("marks weekend today correctly while rendering full week", () => {
    const snap = makeSnapshot();
    // Sat Apr 25 2026 12:00 ET
    const nowMs = Date.parse("2026-04-25T16:00:00.000Z");
    const weeks = buildDayBoard({ ...defaultOpts, snapshot: snap, nowMs, todayKey: "2026-04-25" });
    const labels = weeks[0]?.days.map((d) => d.label) ?? [];
    expect(weeks[0]?.days).toHaveLength(7);
    expect(labels).toContain("Saturday, Apr 25");
    expect(weeks[0]?.days.find((d) => d.date === "2026-04-25")?.isToday).toBe(true);
  });

  it("uses an explicit todayKey when provided", () => {
    const snap = makeSnapshot();
    const weeks = buildDayBoard({
      ...defaultOpts,
      snapshot: snap,
      nowMs: Date.parse("2026-04-20T12:00:00.000Z"),
      todayKey: "2026-04-22",
    });
    expect(weeks[0]?.days.find((d) => d.date === "2026-04-20")?.isToday).toBe(false);
    expect(weeks[0]?.days.find((d) => d.date === "2026-04-22")?.isToday).toBe(true);
  });
});

describe("resolveWeekNavigation", () => {
  it("clamps requests before the snapshot window", () => {
    const nav = resolveWeekNavigation({
      requestedDate: "2026-04-01",
      fallbackDate: "2026-04-20",
      windowStartUtc: "2026-04-20T04:00:00.000Z",
      windowEndUtc: "2026-05-04T04:00:00.000Z",
      timezone: "America/New_York",
    });

    expect(nav.weekStart).toBe("2026-04-20");
    expect(nav.hasPrev).toBe(false);
    expect(nav.prevStart).toBe("2026-04-20");
  });

  it("clamps requests after the snapshot window", () => {
    const nav = resolveWeekNavigation({
      requestedDate: "2026-06-01",
      fallbackDate: "2026-04-20",
      windowStartUtc: "2026-04-20T04:00:00.000Z",
      windowEndUtc: "2026-05-04T04:00:00.000Z",
      timezone: "America/New_York",
    });

    expect(nav.weekStart).toBe("2026-04-27");
    expect(nav.hasNext).toBe(false);
    expect(nav.nextStart).toBe("2026-04-27");
  });

  it("falls back from invalid requested date to the fallback date", () => {
    const nav = resolveWeekNavigation({
      requestedDate: "not-a-date",
      fallbackDate: "2026-04-20",
      windowStartUtc: "2026-04-20T04:00:00.000Z",
      windowEndUtc: "2026-05-04T04:00:00.000Z",
      timezone: "America/New_York",
    });

    expect(nav.weekStart).toBe("2026-04-20");
    expect(nav.hasPrev).toBe(false);
    expect(nav.hasNext).toBe(true);
  });
});

describe("trimWeekRowsForScheduleList", () => {
  const TZ = "America/New_York";
  const baseOpts = {
    timezone: TZ,
    workdayStartHour: 9,
    workdayEndHour: 18,
    weeks: 2 as const,
  };

  it("shows today-forward rows only for the selected current week", () => {
    const weeks = buildDayBoard({
      ...baseOpts,
      snapshot: makeSnapshot(),
      startDate: "2026-04-20",
      todayKey: "2026-04-23",
    });

    const out = trimWeekRowsForScheduleList({
      weeks,
      selectedWeekStart: "2026-04-20",
      currentWeekStart: "2026-04-20",
      todayKey: "2026-04-23",
    });

    expect(out).toHaveLength(2);
    expect(out[0]?.days.map((d) => d.date)).toEqual([
      "2026-04-23",
      "2026-04-24",
      "2026-04-25",
      "2026-04-26",
    ]);
    expect(out[1]?.days).toHaveLength(7);
  });

  it("shows only Sunday when today is Sunday in the selected current week", () => {
    const weeks = buildDayBoard({
      ...baseOpts,
      snapshot: makeSnapshot(),
      startDate: "2026-04-20",
      todayKey: "2026-04-26",
    });

    const out = trimWeekRowsForScheduleList({
      weeks,
      selectedWeekStart: "2026-04-20",
      currentWeekStart: "2026-04-20",
      todayKey: "2026-04-26",
    });

    expect(out[0]?.days.map((d) => d.date)).toEqual(["2026-04-26"]);
    expect(out[1]?.days).toHaveLength(7);
  });

  it("keeps all 7 days for a selected future week", () => {
    const weeks = buildDayBoard({
      ...baseOpts,
      snapshot: makeSnapshot(),
      startDate: "2026-04-27",
      todayKey: "2026-04-23",
    });

    const out = trimWeekRowsForScheduleList({
      weeks,
      selectedWeekStart: "2026-04-27",
      currentWeekStart: "2026-04-20",
      todayKey: "2026-04-23",
    });

    expect(out[0]?.days).toHaveLength(7);
    expect(out[0]?.days[0]?.date).toBe("2026-04-27");
  });
});

describe("buildMonthBoard", () => {
  const TZ = "America/New_York";

  it("builds full 7-day weeks for the month grid", () => {
    const snap = makeSnapshot();
    const month = buildMonthBoard({
      snapshot: snap,
      month: "2026-04",
      timezone: TZ,
    });

    expect(month.label).toBe("April 2026");
    expect(month.weeks.length).toBeGreaterThanOrEqual(4);
    for (const w of month.weeks) {
      expect(w.days).toHaveLength(7);
    }
  });

  it("marks a day booked when any busy interval overlaps that day", () => {
    const snap = makeSnapshot({
      busy: [{ startUtc: "2026-04-26T04:00:00.000Z", endUtc: "2026-04-27T04:00:00.000Z" }],
    });
    const month = buildMonthBoard({
      snapshot: snap,
      month: "2026-04",
      timezone: TZ,
    });

    const days = month.weeks.flatMap((w) => w.days);
    expect(days.find((d) => d.date === "2026-04-26")?.status).toBe("booked");
    expect(days.find((d) => d.date === "2026-04-25")?.status).toBe("available");
  });

  it("attaches booked-day event names for month cells", () => {
    const snap = makeSnapshot({
      busy: [{ startUtc: "2026-04-26T04:00:00.000Z", endUtc: "2026-04-27T04:00:00.000Z" }],
      namedEvents: [
        { startUtc: "2026-04-26T14:00:00.000Z", endUtc: "2026-04-26T15:00:00.000Z", summary: "LA#71411 Wilmington Flower Market", calendarId: "jobs", displayMode: "details" },
        { startUtc: "2026-04-26T16:00:00.000Z", endUtc: "2026-04-26T17:00:00.000Z", summary: "Load In", calendarId: "jobs", displayMode: "details" },
      ],
    });
    const month = buildMonthBoard({
      snapshot: snap,
      month: "2026-04",
      timezone: TZ,
    });

    const day = month.weeks.flatMap((w) => w.days).find((d) => d.date === "2026-04-26");
    expect(day?.eventNames).toEqual([
      "LA#71411 Wilmington Flower Market",
      "Load In",
    ]);
  });

  it("renders one multi-day public event as one bar segment in a single week row", () => {
    const snap = makeSnapshot({
      busy: [{ startUtc: "2026-04-30T04:00:00.000Z", endUtc: "2026-05-04T04:00:00.000Z" }],
      namedEvents: [
        {
          startUtc: "2026-04-30T04:00:00.000Z",
          endUtc: "2026-05-04T04:00:00.000Z",
          summary: "LA#71456 Desert",
          calendarId: "jobs",
          displayMode: "details",
        },
      ],
    });

    const month = buildMonthBoard({
      snapshot: snap,
      month: "2026-04",
      timezone: TZ,
    });

    const week = month.weeks.find((w) => w.days.some((d) => d.date === "2026-04-30"));
    expect(week?.bars).toHaveLength(1);
    expect(week?.bars[0]).toMatchObject({
      label: "LA#71456",
      startDayIndex: 3,
      endDayIndex: 6,
    });
  });

  it("splits a multi-day event across month week-row boundaries", () => {
    const snap = makeSnapshot({
      busy: [{ startUtc: "2026-04-24T04:00:00.000Z", endUtc: "2026-04-29T04:00:00.000Z" }],
      namedEvents: [
        {
          startUtc: "2026-04-24T04:00:00.000Z",
          endUtc: "2026-04-29T04:00:00.000Z",
          summary: "LA#70001 Wilmington Flower Market",
          calendarId: "jobs",
          displayMode: "details",
        },
      ],
    });

    const month = buildMonthBoard({
      snapshot: snap,
      month: "2026-04",
      timezone: TZ,
    });

    const bars = month.weeks.flatMap((w) => w.bars).filter((b) => b.label === "LA#70001");
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ startDayIndex: 4, endDayIndex: 6 });
    expect(bars[1]).toMatchObject({ startDayIndex: 0, endDayIndex: 1 });
  });

  it("masks private bars as Unavailable and never exposes private summaries", () => {
    const snap = makeSnapshot({
      busy: [{ startUtc: "2026-04-26T04:00:00.000Z", endUtc: "2026-04-28T04:00:00.000Z" }],
      namedEvents: [
        {
          startUtc: "2026-04-26T04:00:00.000Z",
          endUtc: "2026-04-28T04:00:00.000Z",
          summary: "Secret Family Vacation",
          calendarId: "personal",
          displayMode: "private",
        },
      ],
    });
    const month = buildMonthBoard({
      snapshot: snap,
      month: "2026-04",
      timezone: TZ,
    });

    const bars = month.weeks.flatMap((w) => w.bars);
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      expect(bar).toMatchObject({
        label: "Unavailable",
        isPrivateUnavailable: true,
      });
      expect(bar.details[0]?.summary).toBe("Unavailable");
    }
    expect(JSON.stringify(month)).not.toContain("Secret Family Vacation");
  });

  it("keeps LA public bar labels while preserving full details", () => {
    const snap = makeSnapshot({
      busy: [{ startUtc: "2026-04-26T14:00:00.000Z", endUtc: "2026-04-26T18:00:00.000Z" }],
      namedEvents: [
        {
          startUtc: "2026-04-26T14:00:00.000Z",
          endUtc: "2026-04-26T18:00:00.000Z",
          summary: "LA#71760 BPM after game concert Camden Yards Baltimore",
          eventId: "evt_71760",
          description: "Call Time: 8:00 AM\nJob Notes: Bring radios",
          ownerEditor: "dave",
          calendarId: "jobs",
          displayMode: "details",
        },
      ],
    });
    const month = buildMonthBoard({
      snapshot: snap,
      month: "2026-04",
      timezone: TZ,
    });

    const bar = month.weeks.flatMap((w) => w.bars).find((b) => b.label === "LA#71760");
    expect(bar).toBeTruthy();
    expect(bar?.details[0]?.summary).toBe("LA#71760 BPM after game concert Camden Yards Baltimore");
    expect(bar?.details[0]?.eventId).toBe("evt_71760");
    expect(bar?.details[0]?.description).toBe("Call Time: 8:00 AM\nJob Notes: Bring radios");
    expect(bar?.details[0]?.ownerEditor).toBe("dave");
    expect(bar?.details[0]?.calendarId).toBe("jobs");
  });

  it("preserves ownerEditor in month bar details for scoped editor actions", () => {
    const snap = makeSnapshot({
      busy: [{ startUtc: "2026-04-26T04:00:00.000Z", endUtc: "2026-04-27T04:00:00.000Z" }],
      namedEvents: [
        {
          startUtc: "2026-04-26T04:00:00.000Z",
          endUtc: "2026-04-27T04:00:00.000Z",
          summary: "Overture",
          eventId: "evt_overture_1",
          ownerEditor: "mike",
          calendarId: "overture@group.calendar.google.com",
          displayMode: "details",
        },
      ],
    });
    const month = buildMonthBoard({
      snapshot: snap,
      month: "2026-04",
      timezone: TZ,
    });

    const bar = month.weeks.flatMap((w) => w.bars).find((b) => b.details[0]?.eventId === "evt_overture_1");
    expect(bar).toBeTruthy();
    expect(bar?.details[0]?.ownerEditor).toBe("mike");
    expect(bar?.details[0]?.calendarId).toBe("overture@group.calendar.google.com");
  });

  it("flags current month and today correctly", () => {
    const snap = makeSnapshot();
    const month = buildMonthBoard({
      snapshot: snap,
      month: "2026-04",
      timezone: TZ,
      nowMs: Date.parse("2026-04-20T12:00:00.000Z"),
    });

    const days = month.weeks.flatMap((w) => w.days);
    expect(days.find((d) => d.date === "2026-04-20")?.isToday).toBe(true);
    expect(days.find((d) => d.date === "2026-04-20")?.isCurrentMonth).toBe(true);
    expect(days.find((d) => d.date === "2026-03-31")?.isCurrentMonth).toBe(false);
  });

  it("supports an explicit todayKey override", () => {
    const snap = makeSnapshot();
    const month = buildMonthBoard({
      snapshot: snap,
      month: "2026-04",
      timezone: TZ,
      todayKey: "2026-04-26",
    });

    const days = month.weeks.flatMap((w) => w.days);
    expect(days.find((d) => d.date === "2026-04-20")?.isToday).toBe(false);
    expect(days.find((d) => d.date === "2026-04-26")?.isToday).toBe(true);
  });
});

describe("resolveMonthNavigation", () => {
  it("clamps months before the snapshot window", () => {
    const nav = resolveMonthNavigation({
      requestedMonth: "2026-01",
      fallbackDate: "2026-04-20",
      windowStartUtc: "2026-04-20T04:00:00.000Z",
      windowEndUtc: "2026-06-15T04:00:00.000Z",
      timezone: "America/New_York",
    });

    expect(nav.monthKey).toBe("2026-04");
    expect(nav.hasPrev).toBe(false);
    expect(nav.prevMonth).toBe("2026-04");
  });

  it("clamps months after the snapshot window", () => {
    const nav = resolveMonthNavigation({
      requestedMonth: "2026-09",
      fallbackDate: "2026-04-20",
      windowStartUtc: "2026-04-20T04:00:00.000Z",
      windowEndUtc: "2026-06-15T04:00:00.000Z",
      timezone: "America/New_York",
    });

    expect(nav.monthKey).toBe("2026-06");
    expect(nav.hasNext).toBe(false);
    expect(nav.nextMonth).toBe("2026-06");
  });

  it("falls back from invalid requested month to the fallback month", () => {
    const nav = resolveMonthNavigation({
      requestedMonth: "not-a-month",
      fallbackDate: "2026-04-20",
      windowStartUtc: "2026-04-20T04:00:00.000Z",
      windowEndUtc: "2026-06-15T04:00:00.000Z",
      timezone: "America/New_York",
    });

    expect(nav.monthKey).toBe("2026-04");
    expect(nav.hasPrev).toBe(false);
    expect(nav.hasNext).toBe(true);
  });
});

describe("summarizeBookedDayLabel", () => {
  it("shows a single LA job number when available", () => {
    const out = summarizeBookedDayLabel(
      ["LA#71411 Wilmington Flower Market"],
      [{
        summary: "LA#71411 Wilmington Flower Market",
        startUtc: "2026-05-06T13:00:00.000Z",
        endUtc: "2026-05-07T22:00:00.000Z",
        dateRangeLabel: "May 6 – May 7",
        displayMode: "details",
      }],
      "details",
    );
    expect(out.label).toBe("LA#71411");
    expect(out.jobNumber).toBe("LA#71411");
  });

  it("shows first LA job number plus count when multiple jobs exist", () => {
    const out = summarizeBookedDayLabel([
      "LA#71411 Wilmington Flower Market",
      "LA#71760 Camden Yards",
      "LA#71760 Camden Yards",
    ]);
    expect(out.label).toBe("LA#71411 +1 more");
  });

  it("falls back to a short title when no LA job number exists", () => {
    const out = summarizeBookedDayLabel(["Wilmington Flower Market"]);
    expect(out.label).toBe("Wilmington Flower Market");
  });

  it("falls back to Busy when event names are missing or generic", () => {
    expect(summarizeBookedDayLabel(undefined).label).toBe("Busy");
    expect(summarizeBookedDayLabel(["Busy"]).label).toBe("Busy");
    expect(summarizeBookedDayLabel(["Busy", "Load In"]).label).toBe("Load In");
  });

  it("returns detail rows for popover content when eventDetails are provided", () => {
    const out = summarizeBookedDayLabel(
      ["LA#70924 UD G"],
      [{
        summary: "LA#70924 UD G",
        startUtc: "2026-04-21T13:30:00.000Z",
        endUtc: "2026-04-21T17:15:00.000Z",
        dateRangeLabel: "Apr 21, 2026",
        timeRangeLabel: "9:30 AM – 1:15 PM",
      }],
    );

    expect(out.label).toBe("LA#70924");
    expect(out.details).toHaveLength(1);
    expect(out.details[0]).toMatchObject({
      summary: "LA#70924 UD G",
      jobNumber: "LA#70924",
      dateRangeLabel: "Apr 21, 2026",
      timeRangeLabel: "9:30 AM – 1:15 PM",
    });
  });

  it("returns Unavailable for private display mode and never exposes private titles", () => {
    const out = summarizeBookedDayLabel(
      ["Secret Family Trip"],
      [{
        summary: "Secret Family Trip",
        startUtc: "2026-05-06T04:00:00.000Z",
        endUtc: "2026-05-08T04:00:00.000Z",
        dateRangeLabel: "May 6 – May 7",
        displayMode: "private",
      }],
      "private",
    );

    expect(out.label).toBe("Unavailable");
    expect(out.isPrivateUnavailable).toBe(true);
    expect(out.title).toBe("Unavailable");
    expect(out.details[0]).toMatchObject({
      summary: "Unavailable",
      dateRangeLabel: "May 6 – May 7",
      displayMode: "private",
    });
  });
});

function makeConnectorDay(
  date: string,
  status: DayStatus["status"],
  eventDetails?: DayStatus["eventDetails"],
  bookedDisplay?: DayStatus["bookedDisplay"],
): DayStatus {
  return {
    date,
    label: date,
    isToday: false,
    isWeekend: false,
    status,
    ...(eventDetails ? { eventDetails } : {}),
    ...(bookedDisplay ? { bookedDisplay } : {}),
  };
}

describe("week connectors", () => {
  const eventA = {
    summary: "LA#71605 Job A",
    startUtc: "2026-07-31T13:00:00.000Z",
    endUtc: "2026-08-02T22:00:00.000Z",
    dateRangeLabel: "Jul 31 – Aug 2",
    displayMode: "details" as const,
  };
  const eventB = {
    summary: "Wilm U Grad - Show Day",
    startUtc: "2026-08-02T13:00:00.000Z",
    endUtc: "2026-08-04T22:00:00.000Z",
    dateRangeLabel: "Aug 2 – Aug 4",
    displayMode: "details" as const,
  };

  it("connects consecutive days only when the exact same event group identity matches", () => {
    const days = [
      makeConnectorDay("2026-07-31", "booked", [eventA]),
      makeConnectorDay("2026-08-01", "booked", [eventA]),
      makeConnectorDay("2026-08-02", "booked", [eventB]),
      makeConnectorDay("2026-08-03", "booked", [eventB]),
    ];
    const keys = days.map((day) => connectorKeyForDay(day));
    const parts = buildWeekConnectorParts([keys])[0];

    expect(parts).toEqual(["start", "end", "start", "end"]);
  });

  it("does not connect adjacent booked rows for different jobs", () => {
    const keys = [
      connectorKeyForDay(makeConnectorDay("2026-08-01", "booked", [eventA])),
      connectorKeyForDay(makeConnectorDay("2026-08-02", "booked", [eventB])),
    ];
    const parts = buildWeekConnectorParts([keys])[0];

    expect(parts).toEqual(["none", "none"]);
  });

  it("does not create cross-week connector continuation states", () => {
    const weekOne = [
      connectorKeyForDay(makeConnectorDay("2026-07-31", "available")),
      connectorKeyForDay(makeConnectorDay("2026-08-01", "booked", [eventA])),
      connectorKeyForDay(makeConnectorDay("2026-08-02", "booked", [eventA])),
    ];
    const weekTwo = [
      connectorKeyForDay(makeConnectorDay("2026-08-03", "booked", [eventA])),
      connectorKeyForDay(makeConnectorDay("2026-08-04", "available")),
    ];

    const [firstWeekParts, secondWeekParts] = buildWeekConnectorParts([weekOne, weekTwo]);
    expect(firstWeekParts).toEqual(["none", "start", "end"]);
    expect(secondWeekParts).toEqual(["none", "none"]);
  });

  it("does not connect across week boundaries when end/start jobs are different", () => {
    const weekOne = [
      connectorKeyForDay(makeConnectorDay("2026-08-01", "booked", [eventA])),
      connectorKeyForDay(makeConnectorDay("2026-08-02", "booked", [eventB])),
    ];
    const weekTwo = [
      connectorKeyForDay(makeConnectorDay("2026-08-03", "booked", [eventB])),
      connectorKeyForDay(makeConnectorDay("2026-08-04", "available")),
    ];

    const [firstWeekParts, secondWeekParts] = buildWeekConnectorParts([weekOne, weekTwo]);
    expect(firstWeekParts).toEqual(["none", "none"]);
    expect(secondWeekParts).toEqual(["none", "none"]);
  });

  it("keeps same-week brackets even when the same job also appears in next week", () => {
    const weekOne = [
      connectorKeyForDay(makeConnectorDay("2026-08-01", "booked", [eventA])),
      connectorKeyForDay(makeConnectorDay("2026-08-02", "booked", [eventA])),
    ];
    const weekTwo = [
      connectorKeyForDay(makeConnectorDay("2026-08-03", "booked", [eventB])),
      connectorKeyForDay(makeConnectorDay("2026-08-04", "booked", [eventB])),
    ];

    const [firstWeekParts] = buildWeekConnectorParts([weekOne, weekTwo]);
    expect(firstWeekParts).toEqual(["start", "end"]);
  });

  it("never emits up-arrow connector states", () => {
    const weekOne = [
      connectorKeyForDay(makeConnectorDay("2026-08-01", "booked", [eventA])),
      connectorKeyForDay(makeConnectorDay("2026-08-02", "booked", [eventA])),
    ];
    const weekTwo = [
      connectorKeyForDay(makeConnectorDay("2026-08-03", "booked", [eventA])),
      connectorKeyForDay(makeConnectorDay("2026-08-04", "booked", [eventA])),
    ];
    const allParts = buildWeekConnectorParts([weekOne, weekTwo]).flat();

    expect((allParts as string[]).includes("continue-start")).toBe(false);
  });

  it("excludes private/unavailable rows from connector identities", () => {
    const privateDay = makeConnectorDay(
      "2026-08-03",
      "booked",
      [{
        summary: "Unavailable",
        startUtc: "2026-08-03T04:00:00.000Z",
        endUtc: "2026-08-04T04:00:00.000Z",
        dateRangeLabel: "Aug 3",
        displayMode: "private",
      }],
      "private",
    );

    expect(connectorKeyForDay(privateDay)).toBeNull();
  });

  it("does not create cross-week connectors for private/unavailable rows", () => {
    const weekOne = [
      connectorKeyForDay(makeConnectorDay("2026-08-01", "booked", [eventA])),
      connectorKeyForDay(makeConnectorDay(
        "2026-08-02",
        "booked",
        [{
          summary: "Unavailable",
          startUtc: "2026-08-02T04:00:00.000Z",
          endUtc: "2026-08-03T04:00:00.000Z",
          dateRangeLabel: "Aug 2",
          displayMode: "private",
        }],
        "private",
      )),
    ];
    const weekTwo = [
      connectorKeyForDay(makeConnectorDay("2026-08-03", "booked", [eventA])),
      connectorKeyForDay(makeConnectorDay("2026-08-04", "available")),
    ];

    const [firstWeekParts, secondWeekParts] = buildWeekConnectorParts([weekOne, weekTwo]);
    expect(firstWeekParts).toEqual(["none", "none"]);
    expect(secondWeekParts).toEqual(["none", "none"]);
  });
});
