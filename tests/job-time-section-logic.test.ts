import { describe, expect, it } from "vitest";
import {
  buildEntriesMapFromResponse,
  parseScheduledStartTimeToHHMM,
  resolveEditFormDefaults,
  resolveJobTimeDisplayRows,
  resolveRowControlState,
  resolveScheduledStartTimeForWorkDate,
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

describe("resolveEditFormDefaults", () => {
  it("defaults new entry In time from scheduled start and keeps Out blank", () => {
    const defaults = resolveEditFormDefaults(null, "8:30 AM");
    expect(defaults).toEqual({ inTime: "08:30", outTime: "" });
  });

  it("leaves In blank when there is no scheduled start", () => {
    expect(resolveEditFormDefaults(null, null)).toEqual({ inTime: "", outTime: "" });
    expect(resolveEditFormDefaults(null, "TBD")).toEqual({ inTime: "", outTime: "" });
  });

  it("keeps existing saved entry times over scheduled defaults", () => {
    const clockInAt = new Date(2026, 4, 20, 14, 5, 0, 0).toISOString();
    const completed = makeEntry({
      clock_in_at: clockInAt,
      clock_out_at: new Date(2026, 4, 20, 18, 15, 0, 0).toISOString(),
    });
    const defaults = resolveEditFormDefaults(completed, "6:00 AM");
    expect(defaults).toEqual({ inTime: "14:05", outTime: "18:15" });
  });

  it("keeps Out blank when editing a running entry", () => {
    const running = makeEntry({ clock_in_at: new Date(2026, 4, 20, 9, 0, 0, 0).toISOString(), clock_out_at: null });
    const defaults = resolveEditFormDefaults(running, "7:00 AM");
    expect(defaults).toEqual({ inTime: "09:00", outTime: "" });
  });
});

describe("resolveScheduledStartTimeForWorkDate", () => {
  it("uses each workDate's own scheduled start for multi-day rows", () => {
    const map = {
      "2026-05-20": "8:00 AM",
      "2026-05-21": "9:30 AM",
    };
    expect(resolveScheduledStartTimeForWorkDate("2026-05-20", map)).toBe("8:00 AM");
    expect(resolveScheduledStartTimeForWorkDate("2026-05-21", map)).toBe("9:30 AM");
  });
});

describe("resolveRowControlState", () => {
  it("does not show Clock In for empty non-today/non-primary rows", () => {
    const state = resolveRowControlState(null, false);
    expect(state).toEqual({
      showClockIn: false,
      showClockOut: false,
      showEditTimes: true,
      showClear: false,
    });
  });

  it("keeps recovery controls for active non-today rows", () => {
    const state = resolveRowControlState(makeEntry({ clock_out_at: null }), false);
    expect(state).toEqual({
      showClockIn: false,
      showClockOut: true,
      showEditTimes: true,
      showClear: true,
    });
  });
});

describe("parseScheduledStartTimeToHHMM", () => {
  it("supports 12-hour and 24-hour scheduled strings", () => {
    expect(parseScheduledStartTimeToHHMM("5:00 AM")).toBe("05:00");
    expect(parseScheduledStartTimeToHHMM("12:30 PM")).toBe("12:30");
    expect(parseScheduledStartTimeToHHMM("17:45")).toBe("17:45");
  });
});
