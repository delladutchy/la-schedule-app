import { describe, expect, it } from "vitest";
import { normalizeWorkDate, resolveDeterministicActiveEntry } from "@/lib/job-time";

describe("normalizeWorkDate", () => {
  it("returns YYYY-MM-DD unchanged", () => {
    expect(normalizeWorkDate("2026-05-18")).toBe("2026-05-18");
  });

  it("normalizes ISO datetime input to YYYY-MM-DD", () => {
    expect(normalizeWorkDate("2026-05-18T13:10:00.000Z")).toBe("2026-05-18");
  });

  it("rejects invalid calendar dates", () => {
    expect(normalizeWorkDate("2026-02-30")).toBeNull();
  });

  it("rejects malformed values", () => {
    expect(normalizeWorkDate("not-a-date")).toBeNull();
    expect(normalizeWorkDate("")).toBeNull();
  });
});

describe("resolveDeterministicActiveEntry", () => {
  const base = {
    id: "row-1",
    google_event_id: "evt-1",
    la_number: null,
    editor_profile: "jeff",
    work_date: "2026-05-18",
    clock_in_at: "2026-05-18T09:00:00.000Z",
    clock_out_at: null,
    notes: null,
    created_at: "2026-05-18T09:00:00.000Z",
    updated_at: "2026-05-18T09:00:00.000Z",
  };

  it("returns null when there are no running entries", () => {
    const completed = {
      ...base,
      id: "row-completed",
      clock_out_at: "2026-05-18T11:00:00.000Z",
    };
    expect(resolveDeterministicActiveEntry([completed])).toBeNull();
  });

  it("returns the most recently updated running entry", () => {
    const older = {
      ...base,
      id: "row-older",
      google_event_id: "evt-older",
      updated_at: "2026-05-18T09:10:00.000Z",
    };
    const newer = {
      ...base,
      id: "row-newer",
      google_event_id: "evt-newer",
      updated_at: "2026-05-18T09:20:00.000Z",
    };
    const selected = resolveDeterministicActiveEntry([older, newer]);
    expect(selected?.id).toBe("row-newer");
    expect(selected?.google_event_id).toBe("evt-newer");
  });
});
