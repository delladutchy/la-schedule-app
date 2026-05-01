import type { EnvConfig } from "./config";

export type EditorAccessScope = "all" | "la" | "overture";
export type EditorOwnershipMode = "any" | "own";
export type EditorBookingMode = "la" | "overture";

export interface EditorProfile {
  editorId: string;
  scope: EditorAccessScope;
  ownership: EditorOwnershipMode;
  bookingMode: EditorBookingMode;
}

export type ProfileCalendarEnv = Pick<EnvConfig, "GOOGLE_CALENDAR_ID" | "OVERTURE_CALENDAR_ID">;

function normalizeEditorId(rawEditorId: string): string {
  return rawEditorId.trim().toLowerCase();
}

export function resolveEditorProfile(rawEditorId: string): EditorProfile {
  const editorId = normalizeEditorId(rawEditorId);
  switch (editorId) {
    case "jeff":
      return { editorId, scope: "all", ownership: "any", bookingMode: "la" };
    case "legacy":
      return { editorId, scope: "all", ownership: "any", bookingMode: "la" };
    case "dave":
      return { editorId, scope: "la", ownership: "any", bookingMode: "la" };
    case "milos":
      return { editorId, scope: "la", ownership: "own", bookingMode: "la" };
    case "mike":
      return { editorId, scope: "overture", ownership: "any", bookingMode: "overture" };
    default:
      // Backward-compatible default for any additional named editor tokens.
      return { editorId, scope: "all", ownership: "any", bookingMode: "la" };
  }
}

function isJeffLikeProfile(profile: EditorProfile): boolean {
  return profile.editorId === "jeff" || profile.editorId === "legacy";
}

export function resolveProfileCreateMode(
  profile: EditorProfile,
  requestedMode?: EditorBookingMode,
): EditorBookingMode {
  if (profile.bookingMode === "overture") {
    return "overture";
  }
  if (profile.scope !== "all" || !isJeffLikeProfile(profile)) {
    return "la";
  }
  return requestedMode === "overture" ? "overture" : "la";
}

export function resolveWriteCalendarForMode(
  bookingMode: EditorBookingMode,
  env: ProfileCalendarEnv,
): { ok: true; calendarId: string } | { ok: false; error: "overture_calendar_not_configured"; message: string } {
  if (bookingMode === "overture") {
    const overtureCalendarId = env.OVERTURE_CALENDAR_ID?.trim();
    if (!overtureCalendarId) {
      return {
        ok: false,
        error: "overture_calendar_not_configured",
        message: "Overture calendar is not configured.",
      };
    }
    return { ok: true, calendarId: overtureCalendarId };
  }
  return { ok: true, calendarId: env.GOOGLE_CALENDAR_ID };
}

export function resolveProfileWriteCalendar(
  profile: EditorProfile,
  env: ProfileCalendarEnv,
): { ok: true; calendarId: string } | { ok: false; error: "overture_calendar_not_configured"; message: string } {
  return resolveWriteCalendarForMode(profile.bookingMode, env);
}

export function isCalendarInProfileScope(
  profile: EditorProfile,
  calendarId: string | undefined,
  env: ProfileCalendarEnv,
): boolean {
  if (profile.scope === "all") return true;
  if (!calendarId) return false;

  if (profile.scope === "la") {
    return calendarId === env.GOOGLE_CALENDAR_ID;
  }

  const overtureCalendarId = env.OVERTURE_CALENDAR_ID?.trim();
  return !!overtureCalendarId && calendarId === overtureCalendarId;
}

export function canProfileManageEvent(
  profile: EditorProfile,
  event: { calendarId?: string; ownerEditor?: string },
  env: ProfileCalendarEnv,
): boolean {
  if (!isCalendarInProfileScope(profile, event.calendarId, env)) {
    return false;
  }
  if (profile.ownership === "any") {
    return true;
  }

  const ownerEditor = event.ownerEditor?.trim().toLowerCase();
  return !!ownerEditor && ownerEditor === profile.editorId;
}

export function isOwnOnlyProfile(profile: EditorProfile): boolean {
  return profile.ownership === "own";
}

export function isMikeProfile(profile: EditorProfile): boolean {
  return profile.editorId === "mike";
}
