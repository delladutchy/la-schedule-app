import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { buildWorkdayWindows, sliceIntoSlots, formatLocalTime } from "@/lib/time";

describe("buildWorkdayWindows", () => {
  it("builds the right number of days", () => {
    const ws = buildWorkdayWindows("2025-10-13", 5, 9, 18, "America/Los_Angeles");
    expect(ws).toHaveLength(5);
  });

  it("labels weekends correctly", () => {
    const ws = buildWorkdayWindows("2025-10-13", 7, 9, 18, "America/Los_Angeles");
    // Oct 13 2025 is a Monday
    expect(ws[0]?.isWeekend).toBe(false); // Mon
    expect(ws[5]?.isWeekend).toBe(true);  // Sat
    expect(ws[6]?.isWeekend).toBe(true);  // Sun
  });

  it("produces a 9-hour window for a standard day", () => {
    const ws = buildWorkdayWindows("2025-10-13", 1, 9, 18, "America/Los_Angeles");
    const durationMs = ws[0]!.endMs - ws[0]!.startMs;
    expect(durationMs).toBe(9 * 60 * 60 * 1000);
  });

  it("DST spring-forward: the workday still starts at 9:00 local time", () => {
    // Mar 9 2025: DST starts in US at 2am. A 9am workday should still be 9am local.
    const ws = buildWorkdayWindows("2025-03-09", 1, 9, 18, "America/Los_Angeles");
    const startLocal = DateTime.fromMillis(ws[0]!.startMs, { zone: "utc" })
      .setZone("America/Los_Angeles");
    expect(startLocal.hour).toBe(9);
    expect(startLocal.minute).toBe(0);
    // And the workday should still be 9 hours of wall-clock time.
    const endLocal = DateTime.fromMillis(ws[0]!.endMs, { zone: "utc" })
      .setZone("America/Los_Angeles");
    expect(endLocal.hour).toBe(18);
  });

  it("DST fall-back: the workday still starts at 9:00 local time", () => {
    // Nov 2 2025: DST ends in US.
    const ws = buildWorkdayWindows("2025-11-02", 1, 9, 18, "America/Los_Angeles");
    const startLocal = DateTime.fromMillis(ws[0]!.startMs, { zone: "utc" })
      .setZone("America/Los_Angeles");
    expect(startLocal.hour).toBe(9);
  });

  it("works with hideWeekends-style filtering at the caller level", () => {
    // We don't hide here; the view layer filters. But weekends should be flagged.
    const ws = buildWorkdayWindows("2025-10-11", 2, 9, 18, "America/Los_Angeles");
    expect(ws[0]?.isWeekend).toBe(true); // Sat
    expect(ws[1]?.isWeekend).toBe(true); // Sun
  });
});

describe("sliceIntoSlots", () => {
  it("divides a 9-hour window into 18 half-hour slots", () => {
    const ws = buildWorkdayWindows("2025-10-13", 1, 9, 18, "America/Los_Angeles");
    const slots = sliceIntoSlots(ws[0]!, 30);
    expect(slots).toHaveLength(18);
  });

  it("rejects slot sizes that don't divide 60", () => {
    const ws = buildWorkdayWindows("2025-10-13", 1, 9, 18, "America/Los_Angeles");
    expect(() => sliceIntoSlots(ws[0]!, 7 as unknown as 15)).toThrow();
  });

  it("slots cover the entire window without gaps or overlap", () => {
    const ws = buildWorkdayWindows("2025-10-13", 1, 9, 18, "America/Los_Angeles");
    const slots = sliceIntoSlots(ws[0]!, 30);
    expect(slots[0]?.startMs).toBe(ws[0]!.startMs);
    expect(slots[slots.length - 1]?.endMs).toBe(ws[0]!.endMs);
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i]?.startMs).toBe(slots[i - 1]?.endMs);
    }
  });
});

describe("formatLocalTime", () => {
  it("formats in the requested zone, not UTC", () => {
    // 2025-10-13T16:00:00Z is 9am PDT
    const ms = Date.parse("2025-10-13T16:00:00Z");
    expect(formatLocalTime(ms, "America/Los_Angeles")).toMatch(/9:00 AM/);
    expect(formatLocalTime(ms, "America/New_York")).toMatch(/12:00 PM/);
  });
});
