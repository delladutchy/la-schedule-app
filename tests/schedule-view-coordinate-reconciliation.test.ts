/**
 * Coordinate reconciliation on the initial board load.
 *
 * Root cause this covers: the PWA service worker replayed an SSR shell cached
 * on an earlier date, so routeTarget was seeded with past coordinates (e.g.
 * month 2026-08). /api/board/window silently clamps a past week/month up to the
 * current one and answers 200/ok with DIFFERENT selected coordinates
 * (monthKey 2026-09). The client's exact-match render gate rejected every such
 * response, so activePayload stayed null and the board hung on the skeleton —
 * and because a response had "arrived", the retry/failure state never engaged.
 *
 * reconcileMountResponseTarget is the real helper from ScheduleView.tsx.
 */

import { describe, it, expect } from "vitest";
import {
  reconcileMountResponseTarget,
  resolveBoardLoadRetryPlan,
  resolveBoardLoadUiState,
} from "@/components/ScheduleView";

// Stale August shell coordinates vs. what the server clamps them to.
const STALE_AUGUST = { weekStart: "2026-08-24", monthKey: "2026-08" };
const CLAMPED_SEPTEMBER = { weekStart: "2026-08-31", monthKey: "2026-09" };

describe("stale August target + API-clamped September payload", () => {
  it("adopts the returned coordinates and becomes renderable (month view)", () => {
    const result = reconcileMountResponseTarget({
      allowAdoption: true,
      activeView: "month",
      payloadView: "month",
      requestedTarget: STALE_AUGUST,
      returnedTarget: CLAMPED_SEPTEMBER,
    });
    expect(result.adoptedTarget).toEqual(CLAMPED_SEPTEMBER);
    expect(result.renderable).toBe(true);
  });

  it("adopts the returned week for the list view too", () => {
    const result = reconcileMountResponseTarget({
      allowAdoption: true,
      activeView: "list",
      payloadView: "list",
      requestedTarget: STALE_AUGUST,
      returnedTarget: CLAMPED_SEPTEMBER,
    });
    expect(result.adoptedTarget).toEqual(CLAMPED_SEPTEMBER);
    expect(result.renderable).toBe(true);
  });

  it("renders instead of hanging on the skeleton", () => {
    const { renderable } = reconcileMountResponseTarget({
      allowAdoption: true,
      activeView: "month",
      payloadView: "month",
      requestedTarget: STALE_AUGUST,
      returnedTarget: CLAMPED_SEPTEMBER,
    });
    // renderable → a payload lands in the active slot → isLoading goes false.
    expect(resolveBoardLoadUiState({ isLoading: !renderable, loadFailed: false })).toBe("ready");
  });

  it("does nothing when the server did not clamp", () => {
    const result = reconcileMountResponseTarget({
      allowAdoption: true,
      activeView: "month",
      payloadView: "month",
      requestedTarget: CLAMPED_SEPTEMBER,
      returnedTarget: CLAMPED_SEPTEMBER,
    });
    expect(result.adoptedTarget).toBeNull();
    expect(result.renderable).toBe(true);
  });
});

describe("adoption only on the active recovery path", () => {
  it("does not adopt when adoption is not allowed (debounce / visibility refresh)", () => {
    const result = reconcileMountResponseTarget({
      allowAdoption: false,
      activeView: "month",
      payloadView: "month",
      requestedTarget: STALE_AUGUST,
      returnedTarget: CLAMPED_SEPTEMBER,
    });
    expect(result.adoptedTarget).toBeNull();
    expect(result.renderable).toBe(false);
  });

  it("never adopts from a response belonging to the other view", () => {
    const result = reconcileMountResponseTarget({
      allowAdoption: true,
      activeView: "month",
      payloadView: "list", // list response can never retarget the month view
      requestedTarget: STALE_AUGUST,
      returnedTarget: CLAMPED_SEPTEMBER,
    });
    expect(result.adoptedTarget).toBeNull();
    expect(result.renderable).toBe(false);
  });

  it("keys the match on the active view's own coordinate", () => {
    // Month view: a differing weekStart alone is not a mismatch.
    const monthOk = reconcileMountResponseTarget({
      allowAdoption: true,
      activeView: "month",
      payloadView: "month",
      requestedTarget: { weekStart: "2026-08-24", monthKey: "2026-09" },
      returnedTarget: { weekStart: "2026-08-31", monthKey: "2026-09" },
    });
    expect(monthOk.adoptedTarget).toBeNull();
    expect(monthOk.renderable).toBe(true);

    // List view: a differing monthKey alone is not a mismatch.
    const listOk = reconcileMountResponseTarget({
      allowAdoption: true,
      activeView: "list",
      payloadView: "list",
      requestedTarget: { weekStart: "2026-08-31", monthKey: "2026-08" },
      returnedTarget: { weekStart: "2026-08-31", monthKey: "2026-09" },
    });
    expect(listOk.adoptedTarget).toBeNull();
    expect(listOk.renderable).toBe(true);
  });
});

// Mirrors the late-response guard in applyResponse: setRouteTarget only moves
// when routeTarget is still the target this effect run actually requested.
function commitAdoptedTarget(
  current: { weekStart: string; monthKey: string },
  requested: { weekStart: string; monthKey: string },
  adopted: { weekStart: string; monthKey: string },
): { weekStart: string; monthKey: string } {
  return current.weekStart === requested.weekStart && current.monthKey === requested.monthKey
    ? adopted
    : current;
}

describe("abandoned / late responses cannot overwrite a newer target", () => {
  it("applies the adopted target when the request is still current", () => {
    const next = commitAdoptedTarget(STALE_AUGUST, STALE_AUGUST, CLAMPED_SEPTEMBER);
    expect(next).toEqual(CLAMPED_SEPTEMBER);
  });

  it("leaves a newer navigation target untouched", () => {
    const userNavigatedTo = { weekStart: "2026-10-05", monthKey: "2026-10" };
    const next = commitAdoptedTarget(userNavigatedTo, STALE_AUGUST, CLAMPED_SEPTEMBER);
    expect(next).toEqual(userNavigatedTo);
  });

  it("does not yank the user back after a Next click", () => {
    const afterNext = { weekStart: "2026-08-31", monthKey: "2026-10" };
    const next = commitAdoptedTarget(afterNext, STALE_AUGUST, CLAMPED_SEPTEMBER);
    expect(next.monthKey).toBe("2026-10");
  });
});

describe("appliedPayload stays false when nothing renderable was applied", () => {
  it("a 200 rejected for target mismatch does not count as applied", () => {
    const { renderable } = reconcileMountResponseTarget({
      allowAdoption: false,
      activeView: "month",
      payloadView: "month",
      requestedTarget: STALE_AUGUST,
      returnedTarget: CLAMPED_SEPTEMBER,
    });
    expect(renderable).toBe(false);
  });

  it("and therefore does not suppress the retry path", () => {
    const { renderable } = reconcileMountResponseTarget({
      allowAdoption: false,
      activeView: "month",
      payloadView: "month",
      requestedTarget: STALE_AUGUST,
      returnedTarget: CLAMPED_SEPTEMBER,
    });
    expect(resolveBoardLoadRetryPlan({
      attempt: 0,
      appliedPayload: renderable,
      hasRenderableActivePayload: false,
      cancelled: false,
    })).toEqual({ action: "retry", delayMs: 1_000 });
  });

  it("a wrong-view response does not suppress the retry path either", () => {
    const { renderable } = reconcileMountResponseTarget({
      allowAdoption: true,
      activeView: "month",
      payloadView: "list",
      requestedTarget: STALE_AUGUST,
      returnedTarget: CLAMPED_SEPTEMBER,
    });
    expect(renderable).toBe(false);
    expect(resolveBoardLoadRetryPlan({
      attempt: 0,
      appliedPayload: renderable,
      hasRenderableActivePayload: false,
      cancelled: false,
    }).action).toBe("retry");
  });

  it("a genuinely renderable payload still suppresses retries", () => {
    const { renderable } = reconcileMountResponseTarget({
      allowAdoption: true,
      activeView: "month",
      payloadView: "month",
      requestedTarget: STALE_AUGUST,
      returnedTarget: CLAMPED_SEPTEMBER,
    });
    expect(renderable).toBe(true);
    expect(resolveBoardLoadRetryPlan({
      attempt: 0,
      appliedPayload: renderable,
      hasRenderableActivePayload: false,
      cancelled: false,
    })).toEqual({ action: "none" });
  });
});
