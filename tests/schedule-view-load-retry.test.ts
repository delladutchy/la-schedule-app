/**
 * Initial-load recovery for the board (Calendar) view.
 *
 * SSR always ships a synthetic skeleton payload, so the first paint depends
 * entirely on the mount fetch. That fetch was single-shot: any null response
 * left the board on "Loading calendar…" forever, because the effect that owns
 * it only re-runs on navigation — which is why clicking Next appeared to fix
 * the hang.
 *
 * resolveBoardLoadRetryPlan and resolveBoardLoadUiState are the real helpers
 * from components/ScheduleView.tsx. The driver below mirrors how the fetch
 * effect consumes them (retry timer bumps loadAttempt, which is an effect
 * dependency, which re-enters the same refresh path).
 */

import { describe, it, expect } from "vitest";
import {
  BOARD_LOAD_MAX_ATTEMPTS,
  BOARD_LOAD_RETRY_BACKOFF_MS,
  resolveBoardLoadRetryPlan,
  resolveBoardLoadUiState,
} from "@/components/ScheduleView";

/**
 * Drive the recovery loop the way the component does.
 * `fetchResults[n]` is whether attempt n applied a renderable payload.
 */
function runLoadSequence(fetchResults: boolean[]): {
  attempts: number;
  delays: number[];
  failed: boolean;
  loadedAt: number | null;
} {
  const delays: number[] = [];
  let attempt = 0;
  let failed = false;
  let loadedAt: number | null = null;

  for (;;) {
    const appliedPayload = fetchResults[attempt] ?? false;
    if (appliedPayload) {
      loadedAt = attempt;
      break;
    }
    const plan = resolveBoardLoadRetryPlan({
      attempt,
      appliedPayload,
      hasRenderableActivePayload: false,
      cancelled: false,
    });
    if (plan.action === "fail") { failed = true; break; }
    if (plan.action === "none") break;
    delays.push(plan.delayMs);
    attempt += 1;
  }

  return { attempts: attempt + 1, delays, failed, loadedAt };
}

describe("failed initial fetch retries", () => {
  it("schedules a retry when the first attempt applies nothing", () => {
    const plan = resolveBoardLoadRetryPlan({
      attempt: 0,
      appliedPayload: false,
      hasRenderableActivePayload: false,
      cancelled: false,
    });
    expect(plan).toEqual({ action: "retry", delayMs: 1_000 });
  });

  it("uses 1s then 3s backoff", () => {
    expect(BOARD_LOAD_RETRY_BACKOFF_MS).toEqual([1_000, 3_000]);
    const { delays } = runLoadSequence([false, false, false]);
    expect(delays).toEqual([1_000, 3_000]);
  });

  it("does not retry when the effect was torn down (unmount / navigation)", () => {
    const plan = resolveBoardLoadRetryPlan({
      attempt: 0,
      appliedPayload: false,
      hasRenderableActivePayload: false,
      cancelled: true,
    });
    expect(plan).toEqual({ action: "none" });
  });

  it("does not retry when a payload arrived from another source", () => {
    const plan = resolveBoardLoadRetryPlan({
      attempt: 0,
      appliedPayload: false,
      hasRenderableActivePayload: true, // e.g. cache hydration landed
      cancelled: false,
    });
    expect(plan).toEqual({ action: "none" });
  });
});

describe("retry cap", () => {
  it("caps automatic attempts at 3 total", () => {
    expect(BOARD_LOAD_MAX_ATTEMPTS).toBe(3);
    const { attempts, delays, failed } = runLoadSequence([false, false, false, false]);
    expect(attempts).toBe(3);
    expect(delays).toHaveLength(2);
    expect(failed).toBe(true);
  });

  it("the attempt after the last backoff fails instead of retrying forever", () => {
    expect(resolveBoardLoadRetryPlan({
      attempt: 2,
      appliedPayload: false,
      hasRenderableActivePayload: false,
      cancelled: false,
    })).toEqual({ action: "fail" });
  });
});

describe("successful retry exits loading", () => {
  it("stops after the retry that applies a payload", () => {
    const { attempts, delays, failed, loadedAt } = runLoadSequence([false, true]);
    expect(loadedAt).toBe(1);
    expect(attempts).toBe(2);
    expect(delays).toEqual([1_000]);
    expect(failed).toBe(false);
  });

  it("a payload on the final permitted attempt still succeeds", () => {
    const { failed, loadedAt } = runLoadSequence([false, false, true]);
    expect(loadedAt).toBe(2);
    expect(failed).toBe(false);
  });

  it("renders the board once loading clears", () => {
    expect(resolveBoardLoadUiState({ isLoading: false, loadFailed: false })).toBe("ready");
  });
});

describe("exhausted retries show Retry", () => {
  it("shows the failed state, not an endless skeleton", () => {
    const { failed } = runLoadSequence([false, false, false]);
    expect(failed).toBe(true);
    expect(resolveBoardLoadUiState({ isLoading: true, loadFailed: true })).toBe("failed");
  });

  it("shows the skeleton while attempts are still in progress", () => {
    expect(resolveBoardLoadUiState({ isLoading: true, loadFailed: false })).toBe("skeleton");
  });

  it("never shows the failed state once data is present", () => {
    expect(resolveBoardLoadUiState({ isLoading: false, loadFailed: true })).toBe("ready");
  });
});

// Mirrors handleRetryLoad + the clear-on-success effect in ScheduleView.tsx.
interface RecoveryState { loadAttempt: number; manualRetryToken: number; loadFailed: boolean }

function manualRetry(prev: RecoveryState): RecoveryState {
  return { loadAttempt: 0, manualRetryToken: prev.manualRetryToken + 1, loadFailed: false };
}

/** The fetch effect re-runs when either dependency changes. */
function effectWouldRerun(prev: RecoveryState, next: RecoveryState): boolean {
  return prev.loadAttempt !== next.loadAttempt
    || prev.manualRetryToken !== next.manualRetryToken;
}

function clearOnSuccess(prev: RecoveryState): RecoveryState {
  return { ...prev, loadAttempt: 0, loadFailed: false };
}

describe("manual Retry triggers another fetch", () => {
  it("re-runs the fetch effect from the exhausted state", () => {
    const exhausted: RecoveryState = { loadAttempt: 2, manualRetryToken: 0, loadFailed: true };
    const next = manualRetry(exhausted);
    expect(effectWouldRerun(exhausted, next)).toBe(true);
    expect(next.loadFailed).toBe(false);
    expect(next.loadAttempt).toBe(0);
  });

  it("re-runs even when the attempt counter is already 0", () => {
    // The token guarantees a dependency change, so Retry can never be a no-op.
    const stuck: RecoveryState = { loadAttempt: 0, manualRetryToken: 3, loadFailed: true };
    const next = manualRetry(stuck);
    expect(effectWouldRerun(stuck, next)).toBe(true);
  });

  it("restores the full automatic retry budget", () => {
    const next = manualRetry({ loadAttempt: 2, manualRetryToken: 0, loadFailed: true });
    expect(resolveBoardLoadRetryPlan({
      attempt: next.loadAttempt,
      appliedPayload: false,
      hasRenderableActivePayload: false,
      cancelled: false,
    })).toEqual({ action: "retry", delayMs: 1_000 });
  });
});

describe("successful manual Retry restores the calendar", () => {
  it("clears the failure state and renders the board", () => {
    const retried = manualRetry({ loadAttempt: 2, manualRetryToken: 0, loadFailed: true });
    // The retry fetch applies a payload → hasRenderableActivePayload flips true.
    const cleared = clearOnSuccess(retried);
    expect(cleared).toEqual({ loadAttempt: 0, manualRetryToken: 1, loadFailed: false });
    expect(resolveBoardLoadUiState({ isLoading: false, loadFailed: cleared.loadFailed })).toBe("ready");
  });

  it("a later failed load can still re-enter the recovery cycle", () => {
    const cleared = clearOnSuccess(manualRetry({ loadAttempt: 2, manualRetryToken: 0, loadFailed: true }));
    expect(resolveBoardLoadRetryPlan({
      attempt: cleared.loadAttempt,
      appliedPayload: false,
      hasRenderableActivePayload: false,
      cancelled: false,
    })).toEqual({ action: "retry", delayMs: 1_000 });
  });
});
