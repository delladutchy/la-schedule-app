import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import {
  deriveFocusedDateForMonthKey,
  deriveFocusedDateForWeekTarget,
  deriveListStartFromFocusedDate,
  deriveWeekAnchorDateForMonth,
  deriveMonthKeyFromFocusedDate,
  isTodayClickTarget,
  normalizeWeekStartForCacheLookup,
} from "@/lib/today-navigation";

const TODAY_KEY = "2026-05-04";
const TODAY_MONTH = "2026-05";

describe("isTodayClickTarget", () => {
  describe("week (list) view", () => {
    it("returns true when target weekStart equals today key", () => {
      expect(isTodayClickTarget(
        { viewMode: "list", weekStart: TODAY_KEY, monthKey: "2026-05" },
        TODAY_KEY,
        TODAY_MONTH,
      )).toBe(true);
    });

    it("returns false when target weekStart is a different week", () => {
      expect(isTodayClickTarget(
        { viewMode: "list", weekStart: "2026-05-11", monthKey: "2026-05" },
        TODAY_KEY,
        TODAY_MONTH,
      )).toBe(false);
    });

    it("returns false even if monthKey would otherwise match today", () => {
      expect(isTodayClickTarget(
        { viewMode: "list", weekStart: "2026-05-25", monthKey: TODAY_MONTH },
        TODAY_KEY,
        TODAY_MONTH,
      )).toBe(false);
    });
  });

  describe("month view", () => {
    it("returns true when target monthKey equals today month", () => {
      expect(isTodayClickTarget(
        { viewMode: "month", weekStart: "2026-05-04", monthKey: TODAY_MONTH },
        TODAY_KEY,
        TODAY_MONTH,
      )).toBe(true);
    });

    it("returns false when target monthKey is a different month", () => {
      expect(isTodayClickTarget(
        { viewMode: "month", weekStart: "2026-05-04", monthKey: "2026-06" },
        TODAY_KEY,
        TODAY_MONTH,
      )).toBe(false);
    });

    it("returns false even if weekStart would otherwise match today", () => {
      expect(isTodayClickTarget(
        { viewMode: "month", weekStart: TODAY_KEY, monthKey: "2026-08" },
        TODAY_KEY,
        TODAY_MONTH,
      )).toBe(false);
    });
  });

  describe("regression coverage", () => {
    it("does not cross-match week target against month source", () => {
      // weekStart equals today's monthKey-shaped string would never happen
      // in practice, but we still want strict view-mode gating.
      expect(isTodayClickTarget(
        { viewMode: "list", weekStart: TODAY_MONTH, monthKey: TODAY_MONTH },
        TODAY_KEY,
        TODAY_MONTH,
      )).toBe(false);
    });

    it("returns true for month even when weekStart is unrelated", () => {
      expect(isTodayClickTarget(
        { viewMode: "month", weekStart: "1970-01-01", monthKey: TODAY_MONTH },
        TODAY_KEY,
        TODAY_MONTH,
      )).toBe(true);
    });

    it("returns true for week even when monthKey is unrelated", () => {
      expect(isTodayClickTarget(
        { viewMode: "list", weekStart: TODAY_KEY, monthKey: "1970-01" },
        TODAY_KEY,
        TODAY_MONTH,
      )).toBe(true);
    });
  });
});

describe("normalizeWeekStartForCacheLookup", () => {
  const timezone = "America/New_York";

  it("snaps a mid-week date (the Today calendar date) to its Monday", () => {
    // Today's href is `?start=<calendar date>`, which can be any
    // weekday. `weekWindow.weeks` is keyed by the week's Monday — the
    // normalization gates the in-window derive lookup that powers the
    // Today button after a prev/next pushStateHref navigation.
    expect(normalizeWeekStartForCacheLookup({
      weekStart: "2026-05-12", // Tuesday
      timezone,
    })).toBe("2026-05-11"); // Monday of that week
  });

  it("returns Sunday's input as the previous Monday (Luxon week-start)", () => {
    expect(normalizeWeekStartForCacheLookup({
      weekStart: "2026-05-17", // Sunday
      timezone,
    })).toBe("2026-05-11"); // Monday of that ISO week
  });

  it("leaves an already-Monday date unchanged", () => {
    expect(normalizeWeekStartForCacheLookup({
      weekStart: "2026-05-11",
      timezone,
    })).toBe("2026-05-11");
  });

  it("returns the raw input when the date is unparseable (defensive)", () => {
    expect(normalizeWeekStartForCacheLookup({
      weekStart: "not-a-date",
      timezone,
    })).toBe("not-a-date");
  });
});

describe("focused date navigation helpers", () => {
  const timezone = "America/New_York";

  it("Week of June 8 -> Month resolves to June month key", () => {
    expect(deriveMonthKeyFromFocusedDate({
      focusedDate: "2026-06-08",
      timezone,
      fallbackMonthKey: "2026-05",
    })).toBe("2026-06");
  });

  it("Month June + selected June 12 -> Week keeps June 12 as week start target input", () => {
    expect(deriveListStartFromFocusedDate({
      focusedDate: "2026-06-12",
      fallbackStartDate: "2026-06-01",
    })).toBe("2026-06-12");
  });

  it("today reset in Week returns the current date key", () => {
    expect(deriveListStartFromFocusedDate({
      focusedDate: "2026-05-12",
      fallbackStartDate: "2026-05-01",
    })).toBe("2026-05-12");
  });

  it("today reset in Month resolves current month key", () => {
    expect(deriveMonthKeyFromFocusedDate({
      focusedDate: "2026-05-12",
      timezone,
      fallbackMonthKey: "2026-04",
    })).toBe("2026-05");
  });

  it("week prev/next preserves weekday context when shifting target week", () => {
    expect(deriveFocusedDateForWeekTarget({
      focusedDate: "2026-06-12", // Friday
      targetWeekStart: "2026-06-15",
      sourceWeekStart: "2026-06-08",
      timezone,
    })).toBe("2026-06-19"); // Friday next week
  });

  it("month prev/next preserves day-of-month when possible", () => {
    expect(deriveFocusedDateForMonthKey({
      monthKey: "2026-07",
      timezone,
      fallbackDate: "2026-07-01",
      dayOfMonth: 12,
    })).toBe("2026-07-12");
  });

  it("month prev/next clamps overflowing day-of-month to month end", () => {
    expect(deriveFocusedDateForMonthKey({
      monthKey: "2026-02",
      timezone,
      fallbackDate: "2026-02-01",
      dayOfMonth: 31,
    })).toBe("2026-02-28");
  });

  it("Month November with no selected date anchors Week toggle to a week inside November", () => {
    expect(deriveWeekAnchorDateForMonth({
      monthKey: "2026-11",
      timezone,
      preferredDate: null,
    })).toBe("2026-11-02");
  });

  it("Month November + selected November 12 keeps selected day for Week toggle", () => {
    expect(deriveWeekAnchorDateForMonth({
      monthKey: "2026-11",
      timezone,
      preferredDate: "2026-11-12",
    })).toBe("2026-11-12");
  });

  it("ignores preferred dates outside visible month and falls back to in-month week anchor", () => {
    expect(deriveWeekAnchorDateForMonth({
      monthKey: "2026-11",
      timezone,
      preferredDate: "2026-10-30",
    })).toBe("2026-11-02");
  });

  it("uses today as anchor when visible month is the current month and no preferred date exists", () => {
    expect(deriveWeekAnchorDateForMonth({
      monthKey: "2026-05",
      timezone,
      todayKey: "2026-05-12",
    })).toBe("2026-05-12");
  });

  it("for every month of 2026, returns an in-month anchor whose week starts in that month", () => {
    for (let month = 1; month <= 12; month += 1) {
      const monthKey = `2026-${String(month).padStart(2, "0")}`;
      const anchor = deriveWeekAnchorDateForMonth({
        monthKey,
        timezone,
      });
      const anchorDt = DateTime.fromISO(anchor, { zone: timezone });
      expect(anchorDt.isValid).toBe(true);
      expect(anchorDt.toFormat("yyyy-LL")).toBe(monthKey);
      expect(anchorDt.startOf("week").toFormat("yyyy-LL")).toBe(monthKey);
    }
  });
});
