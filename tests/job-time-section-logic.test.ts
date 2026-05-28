import { describe, expect, it } from "vitest";
import {
  buildClockMutationPayload,
  buildEntriesMapFromResponse,
  parseScheduledStartTimeToHHMM,
  reconcileActiveEntryIntoMap,
  resolveClockInEntry,
  resolveEditFormDefaults,
  resolveEventIdForWorkDate,
  resolveIsThisRowActive,
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

describe("resolveEventIdForWorkDate", () => {
  it("uses the per-day eventId mapping when available", () => {
    const eventIdsByDate = {
      "2026-05-20": "evt-alpha",
      "2026-05-21": "evt-beta",
    };
    expect(resolveEventIdForWorkDate("2026-05-20", "evt-fallback", eventIdsByDate)).toBe("evt-alpha");
    expect(resolveEventIdForWorkDate("2026-05-21", "evt-fallback", eventIdsByDate)).toBe("evt-beta");
  });

  it("falls back to default eventId when mapped value is missing", () => {
    const eventIdsByDate = {
      "2026-05-20": "",
    };
    expect(resolveEventIdForWorkDate("2026-05-20", "evt-fallback", eventIdsByDate)).toBe("evt-fallback");
    expect(resolveEventIdForWorkDate("2026-05-22", "evt-fallback", eventIdsByDate)).toBe("evt-fallback");
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

describe("buildClockMutationPayload", () => {
  it("includes entryId when a running/completed row exists", () => {
    const payload = buildClockMutationPayload("evt-1", "2026-05-20", makeEntry({ id: "row-abc" }));
    expect(payload).toEqual({
      eventId: "evt-1",
      workDate: "2026-05-20",
      entryId: "row-abc",
    });
  });

  it("omits entryId when no entry exists", () => {
    const payload = buildClockMutationPayload("evt-1", "2026-05-20", null);
    expect(payload).toEqual({
      eventId: "evt-1",
      workDate: "2026-05-20",
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

// ---------------------------------------------------------------------------
// reconcileActiveEntryIntoMap
// Root cause guard: if clock-in returns a pre-existing active row whose
// google_event_id differs from the modal's current eventId, the main GET
// fetch finds nothing on reopen. The reconciliation adds the active entry
// so close/reopen shows the running entry instead of empty.
// ---------------------------------------------------------------------------

describe("reconcileActiveEntryIntoMap", () => {
  it("returns map unchanged when activeEntry is null", () => {
    const map = buildEntriesMapFromResponse([makeEntry()]);
    const result = reconcileActiveEntryIntoMap(map, null, ["2026-05-20"]);
    expect(result.size).toBe(1);
    expect(result.get("2026-05-20")?.id).toBe("row-1");
  });

  it("returns map unchanged when activeEntry has clock_out_at set (not running)", () => {
    const map = new Map<string, JobTimeEntry>();
    const completed = makeEntry({ clock_out_at: "2026-05-20T17:00:00.000Z" });
    const result = reconcileActiveEntryIntoMap(map, completed, ["2026-05-20"]);
    expect(result.size).toBe(0);
  });

  it("returns map unchanged when activeEntry has no clock_in_at", () => {
    const map = new Map<string, JobTimeEntry>();
    const empty = makeEntry({ clock_in_at: null });
    const result = reconcileActiveEntryIntoMap(map, empty, ["2026-05-20"]);
    expect(result.size).toBe(0);
  });

  it("returns map unchanged when activeEntry.work_date is not in workDates", () => {
    const map = new Map<string, JobTimeEntry>();
    const active = makeEntry({ work_date: "2026-05-19" });
    const result = reconcileActiveEntryIntoMap(map, active, ["2026-05-20"]);
    expect(result.size).toBe(0);
  });

  it("does not override an existing entry already found by the main GET", () => {
    const existing = makeEntry({
      id: "existing-row",
      work_date: "2026-05-20",
      clock_out_at: "2026-05-20T17:00:00.000Z",
    });
    const map = buildEntriesMapFromResponse([existing]);
    const active = makeEntry({ id: "active-row", work_date: "2026-05-20" });
    const result = reconcileActiveEntryIntoMap(map, active, ["2026-05-20"]);
    expect(result.get("2026-05-20")?.id).toBe("existing-row");
  });

  // Core readback fix: active entry has a different google_event_id but the
  // same work_date — the main GET (which queries by current eventId) returns
  // nothing, so the reconciliation adds the active entry so reopen shows it.
  it("adds active entry when work_date matches and main GET found nothing for that date", () => {
    const map = new Map<string, JobTimeEntry>();
    const active = makeEntry({ google_event_id: "evt-different", work_date: "2026-05-20" });
    const result = reconcileActiveEntryIntoMap(map, active, ["2026-05-20"]);
    expect(result.size).toBe(1);
    expect(result.get("2026-05-20")?.id).toBe("row-1");
    expect(result.get("2026-05-20")?.google_event_id).toBe("evt-different");
  });

  it("adds active entry and normalizes ISO work_date to YYYY-MM-DD", () => {
    const map = new Map<string, JobTimeEntry>();
    const active = makeEntry({ work_date: "2026-05-20T00:00:00.000Z" });
    const result = reconcileActiveEntryIntoMap(map, active, ["2026-05-20"]);
    expect(result.get("2026-05-20")?.work_date).toBe("2026-05-20");
  });

  it("does not mutate the original map", () => {
    const map = new Map<string, JobTimeEntry>();
    const active = makeEntry({ work_date: "2026-05-20" });
    const result = reconcileActiveEntryIntoMap(map, active, ["2026-05-20"]);
    expect(map.size).toBe(0);
    expect(result.size).toBe(1);
  });

  it("only adds the active entry for matching workDates; leaves other dates untouched", () => {
    const existing = makeEntry({ id: "row-may19", work_date: "2026-05-19" });
    const map = buildEntriesMapFromResponse([existing]);
    const active = makeEntry({ id: "row-may20", work_date: "2026-05-20" });
    const result = reconcileActiveEntryIntoMap(map, active, ["2026-05-19", "2026-05-20"]);
    expect(result.get("2026-05-19")?.id).toBe("row-may19");
    expect(result.get("2026-05-20")?.id).toBe("row-may20");
  });
});

// ---------------------------------------------------------------------------
// resolveClockInEntry
// Guards the clock-in confirmation fix: the POST response entry must be
// trusted immediately without a secondary /active round-trip.
// ---------------------------------------------------------------------------

describe("resolveClockInEntry", () => {
  it("returns the entry when POST response is a valid running row", () => {
    const entry = makeEntry({ clock_in_at: "2026-05-27T14:00:00.000Z", clock_out_at: null });
    expect(resolveClockInEntry(entry)).toBe(entry);
  });

  it("returns null when entry is null", () => {
    expect(resolveClockInEntry(null)).toBeNull();
  });

  it("returns null when entry is undefined", () => {
    expect(resolveClockInEntry(undefined)).toBeNull();
  });

  it("returns null when clock_in_at is null (not yet clocked in)", () => {
    expect(resolveClockInEntry(makeEntry({ clock_in_at: null }))).toBeNull();
  });

  it("returns null when clock_out_at is set (completed entry, not running)", () => {
    const completed = makeEntry({
      clock_in_at: "2026-05-27T14:00:00.000Z",
      clock_out_at: "2026-05-27T18:00:00.000Z",
    });
    expect(resolveClockInEntry(completed)).toBeNull();
  });

  it("accepts a reused active entry whose google_event_id differs from the current modal", () => {
    // The clock-in route may return an existing active row from a different event.
    // The client must accept it immediately regardless of google_event_id.
    const reused = makeEntry({ google_event_id: "evt-other", clock_out_at: null });
    expect(resolveClockInEntry(reused)).toBe(reused);
  });
});

// ---------------------------------------------------------------------------
// resolveIsThisRowActive
// Root cause guard: a stale active row from a different job (same work_date,
// different google_event_id) must NOT make this modal show Clock Out.
// Both work_date AND google_event_id must match the current modal's eventId.
// ---------------------------------------------------------------------------

describe("resolveIsThisRowActive", () => {
  it("returns true when activeEntry matches both eventId and workDate", () => {
    const active = makeEntry({
      google_event_id: "evt-current",
      work_date: "2026-05-27",
      clock_in_at: "2026-05-27T23:07:00.000Z",
      clock_out_at: null,
    });
    expect(resolveIsThisRowActive(active, "evt-current", "2026-05-27")).toBe(true);
  });

  it("returns false for stale active row from different event with same workDate — core Clock Out bug fix", () => {
    // This is the root cause: old buggy clock-in created active rows for wrong events.
    // Same work_date but different google_event_id must NOT trigger Clock Out for this modal.
    const stale = makeEntry({
      google_event_id: "evt-stale-from-old-bug",
      work_date: "2026-05-27",
      clock_in_at: "2026-05-27T20:00:00.000Z",
      clock_out_at: null,
    });
    expect(resolveIsThisRowActive(stale, "evt-current", "2026-05-27")).toBe(false);
  });

  it("returns false when workDate does not match even if eventId matches", () => {
    const active = makeEntry({
      google_event_id: "evt-1",
      work_date: "2026-05-26",
      clock_in_at: "2026-05-26T09:00:00.000Z",
      clock_out_at: null,
    });
    expect(resolveIsThisRowActive(active, "evt-1", "2026-05-27")).toBe(false);
  });

  it("returns false for completed entry (clock_out_at set) even when eventId and workDate match", () => {
    const completed = makeEntry({
      google_event_id: "evt-1",
      work_date: "2026-05-27",
      clock_in_at: "2026-05-27T09:00:00.000Z",
      clock_out_at: "2026-05-27T18:00:00.000Z",
    });
    expect(resolveIsThisRowActive(completed, "evt-1", "2026-05-27")).toBe(false);
  });

  it("returns false when activeEntry is null", () => {
    expect(resolveIsThisRowActive(null, "evt-1", "2026-05-27")).toBe(false);
  });

  it("returns false when activeEntry has no clock_in_at", () => {
    const noClockIn = makeEntry({
      google_event_id: "evt-1",
      work_date: "2026-05-27",
      clock_in_at: null,
      clock_out_at: null,
    });
    expect(resolveIsThisRowActive(noClockIn, "evt-1", "2026-05-27")).toBe(false);
  });

  it("normalizes ISO work_date format on activeEntry when matching", () => {
    const active = makeEntry({
      google_event_id: "evt-1",
      work_date: "2026-05-27T00:00:00.000Z",
      clock_in_at: "2026-05-27T09:00:00.000Z",
      clock_out_at: null,
    });
    expect(resolveIsThisRowActive(active, "evt-1", "2026-05-27")).toBe(true);
  });
});
