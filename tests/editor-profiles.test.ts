import { describe, expect, it } from "vitest";
import {
  canProfileManageEvent,
  resolveProfileCreateMode,
  resolveEditorProfile,
  resolveProfileWriteCalendar,
} from "@/lib/editor-profiles";

const env = {
  GOOGLE_CALENDAR_ID: "la-jobs@group.calendar.google.com",
  OVERTURE_CALENDAR_ID: "overture@group.calendar.google.com",
};

describe("editor profiles", () => {
  it("resolves expected profile scopes", () => {
    expect(resolveEditorProfile("jeff")).toMatchObject({ scope: "all", ownership: "any", bookingMode: "la" });
    expect(resolveEditorProfile("dave")).toMatchObject({ scope: "la", ownership: "any", bookingMode: "la" });
    expect(resolveEditorProfile("milos")).toMatchObject({ scope: "la", ownership: "own", bookingMode: "la" });
    expect(resolveEditorProfile("mike")).toMatchObject({ scope: "overture", ownership: "own", bookingMode: "overture" });
  });

  it("routes write calendar by profile and fails safely for missing Overture calendar", () => {
    expect(resolveProfileWriteCalendar(resolveEditorProfile("dave"), env)).toEqual({
      ok: true,
      calendarId: "la-jobs@group.calendar.google.com",
    });
    expect(resolveProfileWriteCalendar(resolveEditorProfile("mike"), env)).toEqual({
      ok: true,
      calendarId: "overture@group.calendar.google.com",
    });
    expect(resolveProfileWriteCalendar(resolveEditorProfile("mike"), {
      GOOGLE_CALENDAR_ID: env.GOOGLE_CALENDAR_ID,
      OVERTURE_CALENDAR_ID: undefined,
    })).toEqual({
      ok: false,
      error: "overture_calendar_not_configured",
      message: "Overture calendar is not configured.",
    });
  });

  it("resolves create booking mode with Jeff-only overture override", () => {
    expect(resolveProfileCreateMode(resolveEditorProfile("jeff"))).toBe("la");
    expect(resolveProfileCreateMode(resolveEditorProfile("jeff"), "overture")).toBe("overture");
    expect(resolveProfileCreateMode(resolveEditorProfile("legacy"), "overture")).toBe("overture");

    expect(resolveProfileCreateMode(resolveEditorProfile("dave"), "overture")).toBe("la");
    expect(resolveProfileCreateMode(resolveEditorProfile("milos"), "overture")).toBe("la");
    expect(resolveProfileCreateMode(resolveEditorProfile("mike"), "la")).toBe("overture");
  });

  it("enforces calendar and owner scope", () => {
    expect(canProfileManageEvent(resolveEditorProfile("jeff"), {
      calendarId: env.OVERTURE_CALENDAR_ID,
      ownerEditor: "mike",
    }, env)).toBe(true);

    expect(canProfileManageEvent(resolveEditorProfile("dave"), {
      calendarId: env.OVERTURE_CALENDAR_ID,
      ownerEditor: "mike",
    }, env)).toBe(false);

    expect(canProfileManageEvent(resolveEditorProfile("milos"), {
      calendarId: env.GOOGLE_CALENDAR_ID,
      ownerEditor: "milos",
    }, env)).toBe(true);

    expect(canProfileManageEvent(resolveEditorProfile("milos"), {
      calendarId: env.GOOGLE_CALENDAR_ID,
      ownerEditor: "dave",
    }, env)).toBe(false);

    expect(canProfileManageEvent(resolveEditorProfile("mike"), {
      calendarId: env.OVERTURE_CALENDAR_ID,
      ownerEditor: "mike",
    }, env)).toBe(true);

    expect(canProfileManageEvent(resolveEditorProfile("mike"), {
      calendarId: env.GOOGLE_CALENDAR_ID,
      ownerEditor: "mike",
    }, env)).toBe(false);
  });
});
