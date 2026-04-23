import { describe, it, expect } from "vitest";
import {
  mergeIntervals,
  applyBuffers,
  subtract,
  overlapsAny,
  isOverlapTentative,
  normalizeIntervals,
} from "@/lib/intervals";

// Helper: build intervals in minutes since some epoch, for readability.
const M = (startMin: number, endMin: number, tentative?: boolean) => ({
  startMs: startMin * 60_000,
  endMs: endMin * 60_000,
  ...(tentative !== undefined ? { tentative } : {}),
});

describe("normalizeIntervals", () => {
  it("drops empty intervals", () => {
    expect(normalizeIntervals([M(10, 10), M(20, 15), M(0, 5)])).toEqual([M(0, 5)]);
  });
  it("sorts by start ascending", () => {
    expect(normalizeIntervals([M(30, 40), M(0, 10), M(10, 20)]))
      .toEqual([M(0, 10), M(10, 20), M(30, 40)]);
  });
  it("does not mutate input", () => {
    const input = [M(30, 40), M(0, 10)];
    normalizeIntervals(input);
    expect(input[0]).toEqual(M(30, 40));
  });
});

describe("mergeIntervals", () => {
  it("returns empty for empty input", () => {
    expect(mergeIntervals([])).toEqual([]);
  });

  it("preserves non-overlapping intervals", () => {
    expect(mergeIntervals([M(0, 10), M(20, 30), M(40, 50)]))
      .toEqual([M(0, 10), M(20, 30), M(40, 50)]);
  });

  it("merges simple overlap", () => {
    expect(mergeIntervals([M(0, 10), M(5, 15)])).toEqual([M(0, 15)]);
  });

  it("merges ADJACENT intervals (a.end === b.start)", () => {
    // Critical: "9:00-10:00" and "10:00-11:00" should be one block
    expect(mergeIntervals([M(540, 600), M(600, 660)])).toEqual([M(540, 660)]);
  });

  it("merges chains of overlapping intervals", () => {
    expect(mergeIntervals([M(0, 10), M(5, 15), M(14, 20), M(19, 25)]))
      .toEqual([M(0, 25)]);
  });

  it("merges even with out-of-order input", () => {
    expect(mergeIntervals([M(20, 30), M(0, 10), M(5, 25)])).toEqual([M(0, 30)]);
  });

  it("merges fully-contained interval", () => {
    expect(mergeIntervals([M(0, 100), M(20, 30)])).toEqual([M(0, 100)]);
  });

  it("keeps confirmed busy when merging with tentative", () => {
    // Confirmed busy (no tentative flag) should dominate
    const r = mergeIntervals([M(0, 10, true), M(5, 15)]);
    expect(r).toEqual([M(0, 15)]);
    expect(r[0]?.tentative).toBeUndefined();
  });

  it("keeps confirmed busy when the FIRST block is confirmed and a later tentative merges in", () => {
    // Regression: previous impl flipped `last` to tentative when cur was tentative
    // and last had no flag (i.e. last was confirmed).
    const r = mergeIntervals([M(0, 10), M(5, 15, true)]);
    expect(r).toEqual([M(0, 15)]);
    expect(r[0]?.tentative).toBeUndefined();
  });

  it("keeps confirmed busy across a long chain of mixed tentative/confirmed", () => {
    const r = mergeIntervals([
      M(0, 5, true),
      M(4, 10),          // confirmed — dominates
      M(9, 15, true),
      M(14, 20, true),
    ]);
    expect(r).toEqual([M(0, 20)]);
    expect(r[0]?.tentative).toBeUndefined();
  });

  it("keeps tentative when ALL contributing intervals are tentative", () => {
    const r = mergeIntervals([M(0, 10, true), M(5, 15, true)]);
    expect(r.length).toBe(1);
    expect(r[0]?.tentative).toBe(true);
  });

  it("handles single-point overlap (touching boundary)", () => {
    // With half-open intervals, [0,10) and [10,20) touch but do not overlap in set-theory terms.
    // Our merger treats touching as merge-worthy for display (avoids visual gaps).
    expect(mergeIntervals([M(0, 10), M(10, 20)])).toEqual([M(0, 20)]);
  });
});

describe("applyBuffers", () => {
  it("is a no-op with zero buffers", () => {
    const input = [M(100, 110), M(200, 210)];
    expect(applyBuffers(input, 0, 0)).toEqual(input);
  });

  it("extends each interval by buffer and re-merges", () => {
    // 15-min gap between two meetings, 5-min buffer each side → still separate
    const out = applyBuffers([M(0, 30), M(45, 75)], 5 * 60_000, 5 * 60_000);
    expect(out).toEqual([M(-5, 35), M(40, 80)]);
  });

  it("merges close meetings once buffered", () => {
    // 10-min gap, 6-min pre + 6-min post buffers → overlaps, merges
    const out = applyBuffers([M(0, 30), M(40, 70)], 6 * 60_000, 6 * 60_000);
    expect(out).toEqual([M(-6, 76)]);
  });
});

describe("subtract", () => {
  const frame = M(0, 100);

  it("returns whole frame when no busy", () => {
    expect(subtract(frame, [])).toEqual([frame]);
  });

  it("subtracts middle block", () => {
    expect(subtract(frame, [M(30, 50)])).toEqual([M(0, 30), M(50, 100)]);
  });

  it("subtracts leading block", () => {
    expect(subtract(frame, [M(0, 30)])).toEqual([M(30, 100)]);
  });

  it("subtracts trailing block", () => {
    expect(subtract(frame, [M(80, 100)])).toEqual([M(0, 80)]);
  });

  it("returns empty when frame is fully booked", () => {
    expect(subtract(frame, [M(0, 100)])).toEqual([]);
  });

  it("ignores busy blocks outside frame", () => {
    expect(subtract(frame, [M(-50, -10), M(30, 50), M(150, 200)]))
      .toEqual([M(0, 30), M(50, 100)]);
  });

  it("handles multiple adjacent busy blocks", () => {
    expect(subtract(frame, [M(20, 40), M(40, 60)])).toEqual([M(0, 20), M(60, 100)]);
  });
});

describe("overlapsAny / isOverlapTentative", () => {
  it("reports no overlap for empty busy", () => {
    expect(overlapsAny(M(0, 10), [])).toBe(false);
  });
  it("reports overlap for true intersection", () => {
    expect(overlapsAny(M(5, 15), [M(10, 20)])).toBe(true);
  });
  it("reports NO overlap for touching intervals (half-open)", () => {
    // [5,10) and [10,20) touch but do not share any point.
    expect(overlapsAny(M(5, 10), [M(10, 20)])).toBe(false);
  });
  it("tentative: reports tentative when only tentative blocks overlap", () => {
    expect(isOverlapTentative(M(5, 15), [M(10, 20, true)])).toBe(true);
  });
  it("tentative: reports NOT tentative if any overlapping block is confirmed", () => {
    expect(isOverlapTentative(M(5, 15), [M(10, 20, true), M(12, 18)])).toBe(false);
  });
});
