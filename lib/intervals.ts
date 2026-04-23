/**
 * Pure interval arithmetic.
 *
 * Everything here operates on UTC millisecond timestamps and returns new
 * data — no I/O, no clock access, no side effects — so it is trivially
 * testable and deterministic.
 *
 * Conventions:
 *   - All intervals are half-open: [start, end).
 *   - An "empty" interval (start >= end) is always dropped.
 *   - Merging is deterministic: sort by start, fold forward.
 *   - Adjacent intervals (a.end === b.start) are merged into one.
 */

export interface Interval {
  startMs: number;
  endMs: number;
  tentative?: boolean;
}

/** Normalize a list of intervals: drop empty, sort by start ascending. */
export function normalizeIntervals(intervals: Interval[]): Interval[] {
  return intervals
    .filter((i) => i.endMs > i.startMs)
    .slice()
    .sort((a, b) => a.startMs - b.startMs);
}

/**
 * Merge overlapping and adjacent intervals.
 *
 * If any contributing interval is "confirmed busy" (tentative !== true),
 * the merged block is confirmed busy. Tentative-only merges remain tentative.
 * This guarantees: when in doubt, we show busy, not tentative.
 */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = normalizeIntervals(intervals);
  const out: Interval[] = [];

  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.startMs <= last.endMs) {
      // Overlap or touch: extend the end if needed.
      last.endMs = Math.max(last.endMs, cur.endMs);
      // Confirmed busy always dominates. The merged block is tentative
      // ONLY if every contributing block so far has been tentative.
      // An absent `tentative` field means "confirmed busy".
      const curConfirmed = !cur.tentative;
      const lastConfirmed = !last.tentative; // undefined or false -> confirmed
      if (curConfirmed || lastConfirmed) {
        last.tentative = false;
      } else {
        last.tentative = true;
      }
    } else {
      out.push({ ...cur });
    }
  }

  // Normalize: remove the flag entirely when the block is confirmed busy.
  for (const i of out) {
    if (!i.tentative) delete i.tentative;
  }
  return out;
}

/**
 * Apply pre/post buffers to each interval, then merge.
 * Buffers make adjacent-but-close bookings show as one busy block,
 * which is usually what you want.
 */
export function applyBuffers(
  intervals: Interval[],
  preBufferMs: number,
  postBufferMs: number,
): Interval[] {
  if (preBufferMs === 0 && postBufferMs === 0) {
    return mergeIntervals(intervals);
  }
  const buffered = intervals.map((i) => ({
    ...i,
    startMs: i.startMs - preBufferMs,
    endMs: i.endMs + postBufferMs,
  }));
  return mergeIntervals(buffered);
}

/**
 * Subtract `busy` from a single `frame` interval, returning the free gaps.
 * All inputs must be normalized & merged.
 */
export function subtract(frame: Interval, busy: Interval[]): Interval[] {
  const free: Interval[] = [];
  let cursor = frame.startMs;

  for (const b of busy) {
    if (b.endMs <= cursor) continue;
    if (b.startMs >= frame.endMs) break;
    if (b.startMs > cursor) {
      free.push({ startMs: cursor, endMs: Math.min(b.startMs, frame.endMs) });
    }
    cursor = Math.max(cursor, b.endMs);
    if (cursor >= frame.endMs) break;
  }

  if (cursor < frame.endMs) {
    free.push({ startMs: cursor, endMs: frame.endMs });
  }
  return free;
}

/**
 * True iff any part of `query` falls inside any block in `busy`.
 * `busy` must be sorted; uses linear scan (fast enough for days).
 */
export function overlapsAny(query: Interval, busy: Interval[]): boolean {
  for (const b of busy) {
    if (b.endMs <= query.startMs) continue;
    if (b.startMs >= query.endMs) return false;
    return true;
  }
  return false;
}

/**
 * True iff ANY contributing busy block that overlaps `query` is tentative-only.
 * Only called when overlapsAny() is true.
 */
export function isOverlapTentative(query: Interval, busy: Interval[]): boolean {
  let anyConfirmed = false;
  let anyOverlap = false;
  for (const b of busy) {
    if (b.endMs <= query.startMs) continue;
    if (b.startMs >= query.endMs) break;
    anyOverlap = true;
    if (!b.tentative) anyConfirmed = true;
  }
  return anyOverlap && !anyConfirmed;
}
