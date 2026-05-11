import { describe, expect, it } from "vitest";
import type { BoardWindowPayload } from "@/lib/board-window";
import {
  isBackgroundPayloadCompatibleWithView,
  shouldRetainDerivedPayloadOnSyntheticSwap,
} from "@/lib/schedule-view-state";

function makePayload(opts: {
  view: "list" | "month";
  weekStart?: string;
  monthKey?: string;
}): BoardWindowPayload {
  return {
    status: "ok",
    snapshotStatus: "ok",
    generatedAtUtc: "2026-05-04T12:00:00.000Z",
    snapshotWindowStartUtc: "2026-05-04T04:00:00.000Z",
    snapshotWindowEndUtc: "2026-08-04T04:00:00.000Z",
    timezone: "America/New_York",
    resolvedEditorId: "jeff",
    todayKey: "2026-05-04",
    todayMonthKey: "2026-05",
    selected: {
      view: opts.view,
      weekStart: opts.weekStart ?? "2026-05-04",
      monthKey: opts.monthKey ?? "2026-05",
      weekNav: {
        weekStart: opts.weekStart ?? "2026-05-04",
        prevStart: "2026-04-27",
        nextStart: "2026-05-11",
        hasPrev: true,
        hasNext: true,
        canGoPrev: true,
        canGoNext: true,
      },
      monthNav: {
        monthKey: opts.monthKey ?? "2026-05",
        prevMonth: "2026-04",
        nextMonth: "2026-06",
        hasPrev: true,
        hasNext: true,
        canGoPrev: true,
        canGoNext: true,
      },
    },
    selectedBoards: {
      weekRows: [],
      month: { monthKey: opts.monthKey ?? "2026-05", label: "May 2026", weeks: [] },
    },
    weekWindow: {
      startWeek: opts.weekStart ?? "2026-05-04",
      endWeek: "2026-06-29",
      weekCount: 0,
      weeks: [],
    },
    monthWindow: {
      startMonth: opts.monthKey ?? "2026-05",
      endMonth: "2026-09",
      monthCount: 0,
      months: [],
    },
  };
}

describe("shouldRetainDerivedPayloadOnSyntheticSwap", () => {
  it("retains existing visible payload for same-view synthetic SSR swaps", () => {
    const previous = makePayload({ view: "month", weekStart: "2026-05-04", monthKey: "2026-05" });
    const nextInitial = makePayload({ view: "month", weekStart: "2026-05-11", monthKey: "2026-05" });
    expect(shouldRetainDerivedPayloadOnSyntheticSwap({
      previousDerived: previous,
      nextInitialPayload: nextInitial,
      initialPayloadIsSynthetic: true,
    })).toBe(true);
  });

  it("does not retain payload when switching views", () => {
    const previous = makePayload({ view: "list", weekStart: "2026-05-04", monthKey: "2026-05" });
    const nextInitial = makePayload({ view: "month", weekStart: "2026-05-11", monthKey: "2026-05" });
    expect(shouldRetainDerivedPayloadOnSyntheticSwap({
      previousDerived: previous,
      nextInitialPayload: nextInitial,
      initialPayloadIsSynthetic: true,
    })).toBe(false);
  });

  it("does not retain payload for non-synthetic SSR swaps", () => {
    const previous = makePayload({ view: "month" });
    const nextInitial = makePayload({ view: "month" });
    expect(shouldRetainDerivedPayloadOnSyntheticSwap({
      previousDerived: previous,
      nextInitialPayload: nextInitial,
      initialPayloadIsSynthetic: false,
    })).toBe(false);
  });
});

describe("isBackgroundPayloadCompatibleWithView", () => {
  it("rejects mismatched view payloads", () => {
    const payload = makePayload({ view: "list", weekStart: "2026-05-04", monthKey: "2026-05" });
    expect(isBackgroundPayloadCompatibleWithView({
      currentViewMode: "month",
      payload,
    })).toBe(false);
  });

  it("accepts month payloads that match the active month view", () => {
    const payload = makePayload({ view: "month", weekStart: "2026-05-11", monthKey: "2026-05" });
    expect(isBackgroundPayloadCompatibleWithView({
      currentViewMode: "month",
      payload,
    })).toBe(true);
  });

  it("accepts list payloads that match the active list view", () => {
    const payload = makePayload({ view: "list", weekStart: "2026-05-11", monthKey: "2026-06" });
    expect(isBackgroundPayloadCompatibleWithView({
      currentViewMode: "list",
      payload,
    })).toBe(true);
  });
});
