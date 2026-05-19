import { describe, expect, it } from "vitest";
import { resolveJobTimeDisplayRows } from "@/components/JobTimeSection";

describe("resolveJobTimeDisplayRows", () => {
  it("keeps single-day jobs primary on that day", () => {
    const resolved = resolveJobTimeDisplayRows(["2026-05-18"], "2026-05-18");
    expect(resolved.isSingleDay).toBe(true);
    expect(resolved.primaryLiveWorkDate).toBe("2026-05-18");
    expect(resolved.orderedWorkDates).toEqual(["2026-05-18"]);
  });

  it("puts today first for multi-day jobs and allows primary live row only for today", () => {
    const resolved = resolveJobTimeDisplayRows(
      ["2026-05-18", "2026-05-19", "2026-05-20"],
      "2026-05-19",
    );
    expect(resolved.isSingleDay).toBe(false);
    expect(resolved.hasTodayInWorkDates).toBe(true);
    expect(resolved.primaryLiveWorkDate).toBe("2026-05-19");
    expect(resolved.orderedWorkDates).toEqual(["2026-05-19", "2026-05-18", "2026-05-20"]);
  });

  it("returns no primary live row when today is outside multi-day range", () => {
    const resolved = resolveJobTimeDisplayRows(
      ["2026-05-18", "2026-05-19", "2026-05-20"],
      "2026-05-25",
    );
    expect(resolved.isSingleDay).toBe(false);
    expect(resolved.hasTodayInWorkDates).toBe(false);
    expect(resolved.primaryLiveWorkDate).toBeNull();
    expect(resolved.orderedWorkDates).toEqual(["2026-05-18", "2026-05-19", "2026-05-20"]);
  });
});
