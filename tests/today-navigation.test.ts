import { describe, expect, it } from "vitest";
import {
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
