import { describe, it, expect } from "vitest";
import type { Snapshot } from "@/lib/types";
import {
  classifySnapshot,
  buildDayBoard,
  resolveWeekNavigation,
  buildMonthBoard,
  resolveMonthNavigation,
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

  it("shows 5 weekdays (Mon–Fri), no weekends", () => {
    const snap = makeSnapshot();
    const weeks = buildDayBoard({ ...defaultOpts, snapshot: snap });
    expect(weeks).toHaveLength(1);
    expect(weeks[0]?.days).toHaveLength(5);
    const labels = weeks[0]?.days.map((d) => d.label) ?? [];
    expect(labels[0]).toMatch(/^Monday/);
    expect(labels[4]).toMatch(/^Friday/);
    for (const l of labels) {
      expect(l).not.toMatch(/^Saturday|^Sunday/);
    }
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

  it("shows 10 day rows across 2 weeks when weeks=2", () => {
    const snap = makeSnapshot();
    const weeks = buildDayBoard({ ...defaultOpts, snapshot: snap, weeks: 2 });
    expect(weeks).toHaveLength(2);
    expect(weeks[0]?.days).toHaveLength(5);
    expect(weeks[1]?.days).toHaveLength(5);
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
    // Just confirm we produced M–F rows; the labels will reflect NY calendar days.
    expect(weeks[0]?.days).toHaveLength(5);
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
