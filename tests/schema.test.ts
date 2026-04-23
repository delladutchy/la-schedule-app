import { describe, it, expect } from "vitest";
import { SnapshotSchema, BusyBlockSchema } from "@/lib/types";

describe("BusyBlockSchema", () => {
  it("accepts valid block", () => {
    const r = BusyBlockSchema.safeParse({
      startUtc: "2025-10-13T17:00:00.000Z",
      endUtc: "2025-10-13T18:00:00.000Z",
    });
    expect(r.success).toBe(true);
  });

  it("rejects invalid ISO", () => {
    const r = BusyBlockSchema.safeParse({
      startUtc: "not-iso",
      endUtc: "2025-10-13T18:00:00.000Z",
    });
    expect(r.success).toBe(false);
  });
});

describe("SnapshotSchema", () => {
  const base = {
    version: 1 as const,
    generatedAtUtc: "2025-10-13T17:00:00.000Z",
    windowStartUtc: "2025-10-13T07:00:00.000Z",
    windowEndUtc: "2025-10-20T07:00:00.000Z",
    busy: [],
    sourceCalendarIds: ["primary"],
    config: {
      timezone: "America/Los_Angeles",
      workdayStartHour: 9,
      workdayEndHour: 18,
      hideWeekends: true,
      showTentative: false,
      pageTitle: "Availability",
    },
  };

  it("accepts a valid snapshot", () => {
    expect(SnapshotSchema.safeParse(base).success).toBe(true);
  });

  it("rejects wrong version", () => {
    expect(SnapshotSchema.safeParse({ ...base, version: 2 }).success).toBe(false);
  });

  it("rejects bad hour bounds", () => {
    expect(SnapshotSchema.safeParse({
      ...base,
      config: { ...base.config, workdayStartHour: 25 },
    }).success).toBe(false);
  });

  it("rejects extra nonsense fields gracefully via passthrough-off defaults", () => {
    // Zod strips extras by default; should still succeed
    const r = SnapshotSchema.safeParse({ ...base, extra: "junk" });
    expect(r.success).toBe(true);
  });
});
