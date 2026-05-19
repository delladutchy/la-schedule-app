import { describe, expect, it } from "vitest";
import {
  buildEntriesMapFromResponse,
  resolveJobTimeDisplayRows,
  resolveRowInitialEntry,
  type JobTimeEntry,
} from "@/components/JobTimeSection";

function makeEntry(overrides: Partial<JobTimeEntry> = {}): JobTimeEntry {
  return {
    id: "row-1",
    google_event_id: "evt-1",
    la_number: null,
    editor_profile: "jeff",
    work_date: "2026-05-20",
    clock_in_at: "2026-05-20T14:00:00.000Z",
    clock_out_at: null,
    notes: null,
    created_at: "2026-05-20T14:00:00.000Z",
    updated_at: "2026-05-20T14:00:00.000Z",
    ...overrides,
  };
}

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

describe("resolveRowInitialEntry", () => {
  it("keeps a matching active row, then resets to null when initialEntry becomes null", () => {
    const active = makeEntry();
    const matched = resolveRowInitialEntry(active, "evt-1", "2026-05-20");
    expect(matched?.id).toBe("row-1");

    const cleared = resolveRowInitialEntry(null, "evt-1", "2026-05-20");
    expect(cleared).toBeNull();
  });

  it("returns null when eventId or workDate no longer match", () => {
    const active = makeEntry();
    expect(resolveRowInitialEntry(active, "evt-2", "2026-05-20")).toBeNull();
    expect(resolveRowInitialEntry(active, "evt-1", "2026-05-21")).toBeNull();
  });
});

describe("buildEntriesMapFromResponse", () => {
  it("produces empty map when GET returns 0 entries", () => {
    const map = buildEntriesMapFromResponse([]);
    expect(map.size).toBe(0);
    expect(map.get("2026-05-20")).toBeUndefined();
  });

  it("replaces a previously running map when new GET is empty", () => {
    const runningMap = buildEntriesMapFromResponse([makeEntry()]);
    expect(runningMap.get("2026-05-20")?.clock_out_at).toBeNull();

    const emptyMap = buildEntriesMapFromResponse([]);
    expect(emptyMap.size).toBe(0);
    expect(emptyMap.get("2026-05-20")).toBeUndefined();
  });
});
