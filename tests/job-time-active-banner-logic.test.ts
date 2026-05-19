import { describe, expect, it } from "vitest";
import type { JobTimeEntry } from "@/components/JobTimeSection";
import {
  resolvePrimaryActiveEntry,
  shouldRenderActiveClockBanner,
} from "@/components/JobTimeActiveBanner";

function makeEntry(overrides: Partial<JobTimeEntry> = {}): JobTimeEntry {
  return {
    id: "row-1",
    google_event_id: "evt-1",
    la_number: "70924",
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

describe("resolvePrimaryActiveEntry", () => {
  it("returns null when active list is empty", () => {
    expect(resolvePrimaryActiveEntry([])).toBeNull();
  });

  it("returns newest running entry when active entries exist", () => {
    const first = makeEntry({ id: "older", clock_in_at: "2026-05-20T10:00:00.000Z" });
    const newest = makeEntry({ id: "newer", clock_in_at: "2026-05-20T12:00:00.000Z" });
    const completed = makeEntry({
      id: "completed",
      clock_in_at: "2026-05-20T09:00:00.000Z",
      clock_out_at: "2026-05-20T11:00:00.000Z",
    });
    const resolved = resolvePrimaryActiveEntry([first, completed, newest]);
    expect(resolved?.id).toBe("newer");
  });
});

describe("shouldRenderActiveClockBanner", () => {
  it("shows for Jeff when an active entry exists", () => {
    const active = makeEntry();
    expect(shouldRenderActiveClockBanner(true, false, active)).toBe(true);
  });

  it("hides when there is no active entry or banner is suppressed", () => {
    const active = makeEntry();
    const completed = makeEntry({ clock_out_at: "2026-05-20T16:00:00.000Z" });
    expect(shouldRenderActiveClockBanner(true, false, null)).toBe(false);
    expect(shouldRenderActiveClockBanner(true, false, completed)).toBe(false);
    expect(shouldRenderActiveClockBanner(true, true, active)).toBe(false);
    expect(shouldRenderActiveClockBanner(false, false, active)).toBe(false);
  });
});
