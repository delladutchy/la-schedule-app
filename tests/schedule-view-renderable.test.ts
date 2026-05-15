import { describe, expect, it } from "vitest";
import type { BoardWindowPayload } from "@/lib/board-window";
import { resolveRenderableViewPayload } from "@/components/ScheduleView";

function makePayload(opts: {
  view: "list" | "month";
  weekStart?: string;
  monthKey?: string;
  monthWindowMonths?: string[];
  weekWindowWeeks?: string[];
  generatedAtUtc?: string;
}): BoardWindowPayload {
  const weekStart = opts.weekStart ?? "2026-05-04";
  const monthKey = opts.monthKey ?? "2026-05";
  const monthKeys = opts.monthWindowMonths ?? [monthKey];
  const weekStarts = opts.weekWindowWeeks ?? [weekStart];

  return {
    status: "ok",
    snapshotStatus: "ok",
    generatedAtUtc: opts.generatedAtUtc ?? "2026-05-04T12:00:00.000Z",
    snapshotWindowStartUtc: "2026-05-04T04:00:00.000Z",
    snapshotWindowEndUtc: "2026-08-04T04:00:00.000Z",
    timezone: "America/New_York",
    resolvedEditorId: "jeff",
    todayKey: "2026-05-04",
    todayMonthKey: "2026-05",
    selected: {
      view: opts.view,
      weekStart,
      monthKey,
      weekNav: {
        weekStart,
        prevStart: "2026-04-27",
        nextStart: "2026-05-11",
        hasPrev: true,
        hasNext: true,
        canGoPrev: true,
        canGoNext: true,
      },
      monthNav: {
        monthKey,
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
      month: {
        monthKey,
        label: monthKey,
        weeks: [],
      },
    },
    weekWindow: {
      startWeek: weekStarts[0] ?? weekStart,
      endWeek: weekStarts[weekStarts.length - 1] ?? weekStart,
      weekCount: weekStarts.length,
      weeks: weekStarts.map((value) => ({
        weekOf: value,
        label: value,
        days: [],
      })),
    },
    monthWindow: {
      startMonth: monthKeys[0] ?? monthKey,
      endMonth: monthKeys[monthKeys.length - 1] ?? monthKey,
      monthCount: monthKeys.length,
      months: monthKeys.map((value) => ({
        monthKey: value,
        label: value,
        weeks: [],
      })),
    },
  };
}

describe("resolveRenderableViewPayload", () => {
  it("uses richer same-key full-window candidate to derive target month", () => {
    const selectedOnly = makePayload({
      view: "month",
      weekStart: "2026-05-04",
      monthKey: "2026-05",
      monthWindowMonths: ["2026-05"],
      generatedAtUtc: "2026-05-04T12:00:00.000Z",
    });
    const richerFullWindow = makePayload({
      view: "month",
      weekStart: "2026-05-04",
      monthKey: "2026-05",
      monthWindowMonths: ["2026-05", "2026-06"],
      generatedAtUtc: "2026-05-04T12:00:00.000Z",
    });

    const resolved = resolveRenderableViewPayload({
      viewMode: "month",
      targetWeekStart: "2026-06-01",
      targetMonthKey: "2026-06",
      directPayload: selectedOnly,
      listPayload: null,
      monthPayload: selectedOnly,
      initialBoardWindowPayload: selectedOnly,
      boardWindowCache: {
        "month:2026-05-04:2026-05": richerFullWindow,
      },
    });

    expect(resolved?.selected.view).toBe("month");
    expect(resolved?.selected.monthKey).toBe("2026-06");
    expect(resolved?.selectedBoards.month.monthKey).toBe("2026-06");
  });
});
