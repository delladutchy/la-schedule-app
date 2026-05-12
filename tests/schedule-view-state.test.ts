import { describe, expect, it } from "vitest";
import type { BoardWindowPayload } from "@/lib/board-window";
import {
  isBackgroundPayloadCompatibleWithView,
  pickFallbackPayloadForNewView,
  shouldPreferIncomingForTargetMatch,
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

describe("pickFallbackPayloadForNewView", () => {
  it("uses the remembered list payload when toggling Month → Week", () => {
    const previousMonth = makePayload({ view: "month", weekStart: "2026-05-04", monthKey: "2026-05" });
    const previousList = makePayload({ view: "list", weekStart: "2026-05-11", monthKey: "2026-05" });
    expect(pickFallbackPayloadForNewView({
      initialPayloadIsSynthetic: true,
      newView: "list",
      previousDerived: previousMonth,
      lastSeenByView: { list: previousList, month: previousMonth },
    })).toBe(previousList);
  });

  it("uses the remembered month payload when toggling Week → Month", () => {
    const previousList = makePayload({ view: "list", weekStart: "2026-05-11", monthKey: "2026-05" });
    const previousMonth = makePayload({ view: "month", weekStart: "2026-05-04", monthKey: "2026-05" });
    expect(pickFallbackPayloadForNewView({
      initialPayloadIsSynthetic: true,
      newView: "month",
      previousDerived: previousList,
      lastSeenByView: { list: previousList, month: previousMonth },
    })).toBe(previousMonth);
  });

  it("returns null when no payload has been seen for the new view", () => {
    const previousList = makePayload({ view: "list" });
    expect(pickFallbackPayloadForNewView({
      initialPayloadIsSynthetic: true,
      newView: "month",
      previousDerived: previousList,
      lastSeenByView: { list: previousList, month: null },
    })).toBeNull();
  });

  it("returns null on non-synthetic SSR paths even if a payload is remembered", () => {
    const previousList = makePayload({ view: "list" });
    expect(pickFallbackPayloadForNewView({
      initialPayloadIsSynthetic: false,
      newView: "list",
      previousDerived: makePayload({ view: "month" }),
      lastSeenByView: { list: previousList, month: null },
    })).toBeNull();
  });

  it("does not seed a fallback when previousDerived is null (Today reset / first mount)", () => {
    // handleBoardNavigate's Today branch deliberately clears derivedPayload
    // to null before router.push so the new URL's target wins outright.
    // If we hydrated lastSeen here, the old-coord payload would shadow the
    // new today-target render until the mount fetch arrives — exactly the
    // regression this guard prevents.
    const lastSeenList = makePayload({ view: "list", weekStart: "2026-05-18", monthKey: "2026-05" });
    expect(pickFallbackPayloadForNewView({
      initialPayloadIsSynthetic: true,
      newView: "list",
      previousDerived: null,
      lastSeenByView: { list: lastSeenList, month: null },
    })).toBeNull();
  });

  it("does not double-handle same-view swaps (shouldRetain covers those)", () => {
    const previousList = makePayload({ view: "list", weekStart: "2026-05-18", monthKey: "2026-05" });
    const lastSeenList = makePayload({ view: "list", weekStart: "2026-05-04", monthKey: "2026-05" });
    expect(pickFallbackPayloadForNewView({
      initialPayloadIsSynthetic: true,
      newView: "list",
      previousDerived: previousList,
      lastSeenByView: { list: lastSeenList, month: null },
    })).toBeNull();
  });

  it("defensively rejects a remembered entry whose view does not match its slot", () => {
    const corrupted = makePayload({ view: "month", weekStart: "2026-05-04", monthKey: "2026-05" });
    expect(pickFallbackPayloadForNewView({
      initialPayloadIsSynthetic: true,
      newView: "list",
      previousDerived: makePayload({ view: "month" }),
      // Should never happen with the in-component tracker, but guarantees
      // a cross-view payload can never leak through the fallback path.
      lastSeenByView: { list: corrupted, month: null },
    })).toBeNull();
  });
});

describe("shouldPreferIncomingForTargetMatch", () => {
  const target = { weekStart: "2026-05-04", monthKey: "2026-05" };

  it("prefers incoming when it matches target and baseline does not", () => {
    const incoming = makePayload({ view: "list", weekStart: "2026-05-04", monthKey: "2026-05" });
    const baseline = makePayload({ view: "list", weekStart: "2026-05-11", monthKey: "2026-05" });
    expect(shouldPreferIncomingForTargetMatch({ incoming, baseline, target })).toBe(true);
  });

  it("does not switch when both payloads match the target", () => {
    const incoming = makePayload({ view: "list", weekStart: "2026-05-04", monthKey: "2026-05" });
    const baseline = makePayload({ view: "list", weekStart: "2026-05-04", monthKey: "2026-05" });
    expect(shouldPreferIncomingForTargetMatch({ incoming, baseline, target })).toBe(false);
  });

  it("does not switch when neither payload matches the target", () => {
    const incoming = makePayload({ view: "list", weekStart: "2026-06-01", monthKey: "2026-06" });
    const baseline = makePayload({ view: "list", weekStart: "2026-05-11", monthKey: "2026-05" });
    expect(shouldPreferIncomingForTargetMatch({ incoming, baseline, target })).toBe(false);
  });

  it("does not switch when only baseline matches the target", () => {
    const incoming = makePayload({ view: "list", weekStart: "2026-05-11", monthKey: "2026-05" });
    const baseline = makePayload({ view: "list", weekStart: "2026-05-04", monthKey: "2026-05" });
    expect(shouldPreferIncomingForTargetMatch({ incoming, baseline, target })).toBe(false);
  });
});
