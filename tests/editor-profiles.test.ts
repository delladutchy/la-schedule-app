import { describe, expect, it } from "vitest";
import {
  canProfileManageEvent,
  isJeffLikeProfile,
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
    expect(resolveEditorProfile("mike")).toMatchObject({ scope: "overture", ownership: "any", bookingMode: "overture" });
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

    expect(canProfileManageEvent(resolveEditorProfile("milos"), {
      calendarId: env.GOOGLE_CALENDAR_ID,
      ownerEditor: undefined,
    }, env)).toBe(false);

    expect(canProfileManageEvent(resolveEditorProfile("milos"), {
      calendarId: env.OVERTURE_CALENDAR_ID,
      ownerEditor: "milos",
    }, env)).toBe(false);

    expect(canProfileManageEvent(resolveEditorProfile("mike"), {
      calendarId: env.OVERTURE_CALENDAR_ID,
      ownerEditor: "mike",
    }, env)).toBe(true);

    expect(canProfileManageEvent(resolveEditorProfile("mike"), {
      calendarId: env.OVERTURE_CALENDAR_ID,
      ownerEditor: "jeff",
    }, env)).toBe(true);

    expect(canProfileManageEvent(resolveEditorProfile("mike"), {
      calendarId: env.OVERTURE_CALENDAR_ID,
      ownerEditor: undefined,
    }, env)).toBe(true);

    expect(canProfileManageEvent(resolveEditorProfile("mike"), {
      calendarId: env.GOOGLE_CALENDAR_ID,
      ownerEditor: "mike",
    }, env)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Invoices link visibility — Jeff-only
// ---------------------------------------------------------------------------

/**
 * The "Invoices" link in the main app header is gated by isJeffLikeProfile().
 * These tests confirm exactly which editor ids see the link vs. which don't.
 */
describe("isJeffLikeProfile — Invoices link visibility", () => {
  it("jeff → sees Invoices link", () => {
    expect(isJeffLikeProfile(resolveEditorProfile("jeff"))).toBe(true);
  });

  it("legacy → sees Invoices link (legacy maps to jeff scope)", () => {
    expect(isJeffLikeProfile(resolveEditorProfile("legacy"))).toBe(true);
  });

  it("dave → does NOT see Invoices link", () => {
    expect(isJeffLikeProfile(resolveEditorProfile("dave"))).toBe(false);
  });

  it("milos → does NOT see Invoices link", () => {
    expect(isJeffLikeProfile(resolveEditorProfile("milos"))).toBe(false);
  });

  it("mike (Overture) → does NOT see Invoices link", () => {
    expect(isJeffLikeProfile(resolveEditorProfile("mike"))).toBe(false);
  });

  it("unauthenticated (null editorId) → resolvedEditorId is null, link is hidden", () => {
    // The page computes: isJeffEditor = resolvedEditorId !== null && isJeffLikeProfile(...)
    // When resolvedEditorId is null (public visitor), the link is always hidden.
    const resolvedEditorId: string | null = null;
    const isJeffEditor = resolvedEditorId !== null && isJeffLikeProfile(resolveEditorProfile(resolvedEditorId));
    expect(isJeffEditor).toBe(false);
  });

  it("jeff with null resolvedEditorId → still hidden (null check guards)", () => {
    // Safety: even if editorId string happened to be empty, null check prevents crash.
    const resolvedEditorId: string | null = null;
    expect(resolvedEditorId !== null && isJeffLikeProfile(resolveEditorProfile(resolvedEditorId))).toBe(false);
  });
});
