import { describe, expect, it } from "vitest";
import type { BoardWindowPayload } from "@/lib/board-window";
import {
  isPayloadAnImprovement,
  isPayloadRenderableForViewTarget,
} from "@/lib/schedule-view-state";

function makePayload(opts: {
  view: "list" | "month";
  weekStart?: string;
  monthKey?: string;
  generatedAtUtc?: string;
  weekWindowCount?: number;
  monthWindowCount?: number;
}): BoardWindowPayload {
  const weekStart = opts.weekStart ?? "2026-05-04";
  const monthKey = opts.monthKey ?? "2026-05";
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
      month: { monthKey, label: "May 2026", weeks: [] },
    },
    weekWindow: {
      startWeek: weekStart,
      endWeek: "2026-06-29",
      weekCount: opts.weekWindowCount ?? 0,
      weeks: Array.from({ length: opts.weekWindowCount ?? 0 }, () => ({
        weekOf: weekStart,
        label: "Week of May 4",
        days: [],
      })),
    },
    monthWindow: {
      startMonth: monthKey,
      endMonth: "2026-09",
      monthCount: opts.monthWindowCount ?? 0,
      months: Array.from({ length: opts.monthWindowCount ?? 0 }, () => ({
        monthKey,
        label: "May 2026",
        weeks: [],
      })),
    },
  };
}

describe("isPayloadAnImprovement", () => {
  const target = { weekStart: "2026-05-04", monthKey: "2026-05" };

  it("accepts any incoming when current is null (first hydration)", () => {
    const incoming = makePayload({ view: "list" });
    expect(isPayloadAnImprovement({ incoming, current: null, target })).toBe(true);
  });

  it("prefers a strictly newer generatedAtUtc", () => {
    const current = makePayload({
      view: "list",
      generatedAtUtc: "2026-05-04T12:00:00.000Z",
    });
    const incoming = makePayload({
      view: "list",
      generatedAtUtc: "2026-05-04T12:10:00.000Z",
    });
    expect(isPayloadAnImprovement({ incoming, current, target })).toBe(true);
  });

  it("rejects a strictly older generatedAtUtc", () => {
    const current = makePayload({
      view: "list",
      generatedAtUtc: "2026-05-04T12:10:00.000Z",
    });
    const incoming = makePayload({
      view: "list",
      generatedAtUtc: "2026-05-04T12:00:00.000Z",
    });
    expect(isPayloadAnImprovement({ incoming, current, target })).toBe(false);
  });

  it("prefers same-age incoming that matches URL target when current does not", () => {
    // Simulates: user navigated to a new week via router.push, the
    // existing slot still holds the previous week's payload, and the
    // fresh fetch for the new week arrives same-age (same snapshot).
    const current = makePayload({ view: "list", weekStart: "2026-05-11", monthKey: "2026-05" });
    const incoming = makePayload({ view: "list", weekStart: "2026-05-04", monthKey: "2026-05" });
    expect(isPayloadAnImprovement({ incoming, current, target })).toBe(true);
  });

  it("keeps current when only current matches the target (defensive)", () => {
    const current = makePayload({ view: "list", weekStart: "2026-05-04", monthKey: "2026-05" });
    const incoming = makePayload({ view: "list", weekStart: "2026-05-11", monthKey: "2026-05" });
    expect(isPayloadAnImprovement({ incoming, current, target })).toBe(false);
  });

  it("prefers same-age incoming with more wide-window data (stage-1→stage-2 upgrade)", () => {
    const current = makePayload({ view: "list", weekWindowCount: 0 });
    const incoming = makePayload({ view: "list", weekWindowCount: 9 });
    expect(isPayloadAnImprovement({ incoming, current, target })).toBe(true);
  });

  it("keeps current when same-age incoming has no advantage (no flicker)", () => {
    const current = makePayload({ view: "list", weekWindowCount: 9 });
    const incoming = makePayload({ view: "list", weekWindowCount: 9 });
    expect(isPayloadAnImprovement({ incoming, current, target })).toBe(false);
  });

  it("treats same-view list target matching by weekStart only", () => {
    const current = makePayload({
      view: "list",
      weekStart: "2026-11-02",
      monthKey: "2026-10",
      generatedAtUtc: "2026-05-04T12:00:00.000Z",
    });
    const incoming = makePayload({
      view: "list",
      weekStart: "2026-11-09",
      monthKey: "2026-10",
      generatedAtUtc: "2026-05-04T12:00:00.000Z",
    });
    expect(isPayloadAnImprovement({
      incoming,
      current,
      target: { weekStart: "2026-11-09", monthKey: "2026-11" },
    })).toBe(true);
  });

  it("treats same-view month target matching by monthKey only", () => {
    const current = makePayload({
      view: "month",
      weekStart: "2026-06-01",
      monthKey: "2026-06",
      generatedAtUtc: "2026-05-04T12:00:00.000Z",
    });
    const incoming = makePayload({
      view: "month",
      weekStart: "2026-06-29",
      monthKey: "2026-07",
      generatedAtUtc: "2026-05-04T12:00:00.000Z",
    });
    expect(isPayloadAnImprovement({
      incoming,
      current,
      target: { weekStart: "2026-07-06", monthKey: "2026-07" },
    })).toBe(true);
  });
});

describe("isPayloadRenderableForViewTarget", () => {
  it("rejects stale list payloads that do not match the active week target", () => {
    const staleListPayload = makePayload({
      view: "list",
      weekStart: "2026-05-04",
      monthKey: "2026-05",
    });
    expect(isPayloadRenderableForViewTarget({
      viewMode: "list",
      target: {
        weekStart: "2026-11-09",
        monthKey: "2026-11",
      },
      payload: staleListPayload,
    })).toBe(false);
  });

  it("rejects stale month payloads that do not match the active month target", () => {
    const staleMonthPayload = makePayload({
      view: "month",
      weekStart: "2026-05-04",
      monthKey: "2026-05",
    });
    expect(isPayloadRenderableForViewTarget({
      viewMode: "month",
      target: {
        weekStart: "2026-11-09",
        monthKey: "2026-11",
      },
      payload: staleMonthPayload,
    })).toBe(false);
  });

  it("accepts a target-matching week payload for list rendering", () => {
    const targetPayload = makePayload({
      view: "list",
      weekStart: "2026-11-09",
      monthKey: "2026-11",
    });
    expect(isPayloadRenderableForViewTarget({
      viewMode: "list",
      target: {
        weekStart: "2026-11-09",
        monthKey: "2026-11",
      },
      payload: targetPayload,
    })).toBe(true);
  });

  it("accepts a target-matching month payload for month rendering", () => {
    const targetPayload = makePayload({
      view: "month",
      weekStart: "2026-11-09",
      monthKey: "2026-11",
    });
    expect(isPayloadRenderableForViewTarget({
      viewMode: "month",
      target: {
        weekStart: "2026-11-09",
        monthKey: "2026-11",
      },
      payload: targetPayload,
    })).toBe(true);
  });
});
