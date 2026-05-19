import "server-only";
import { getSupabaseServerClient, SupabaseConfigError } from "./supabase";

export type { SupabaseConfigError };

export interface JobTimeEntry {
  id: string;
  google_event_id: string;
  la_number: string | null;
  editor_profile: string;
  work_date: string; // YYYY-MM-DD
  clock_in_at: string | null;
  clock_out_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const WORK_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function normalizeJobTimeEntry(entry: JobTimeEntry): JobTimeEntry {
  const workDate = normalizeWorkDate(entry.work_date);
  if (!workDate) {
    throw new Error(`[job-time] invalid work_date returned from storage: ${entry.work_date}`);
  }
  if (workDate === entry.work_date) return entry;
  return { ...entry, work_date: workDate };
}

/**
 * Normalize a work date to canonical YYYY-MM-DD.
 * Accepts exact YYYY-MM-DD and ISO strings that start with YYYY-MM-DD.
 */
export function normalizeWorkDate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const candidate = trimmed.length >= 10 ? trimmed.slice(0, 10) : trimmed;
  const match = WORK_DATE_PATTERN.exec(candidate);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() + 1 !== month
    || parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function normalizeWorkDateFromUnknown(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return normalizeWorkDate(value);
}

/** Normalize "legacy" token to canonical "jeff" profile in the DB. */
export function normalizeEditorProfile(editorId: string): string {
  return editorId === "legacy" ? "jeff" : editorId;
}

/** Only jeff (and legacy, normalized to jeff) may access time entries. */
export function isJeffEditorId(editorId: string): boolean {
  return editorId === "jeff" || editorId === "legacy";
}

/**
 * Return all time entries for an event + editor, ordered by work_date ascending.
 * If workDate is provided, filters to that date only (returns 0 or 1 items).
 */
export async function getJobTimeEntries(
  googleEventId: string,
  editorProfile: string,
  workDate?: string,
): Promise<JobTimeEntry[]> {
  const client = getSupabaseServerClient();
  let query = client
    .from("job_time_entries")
    .select("*")
    .eq("google_event_id", googleEventId)
    .eq("editor_profile", editorProfile);

  if (workDate) {
    query = query.eq("work_date", workDate);
  }

  const { data, error } = await query.order("work_date", { ascending: true });

  if (error) {
    if (error.code === "PGRST116") return [];
    throw new Error(`[job-time] read failed: ${error.message}`);
  }
  return ((data as JobTimeEntry[]) ?? []).map(normalizeJobTimeEntry);
}

export async function upsertClockIn(
  googleEventId: string,
  editorProfile: string,
  workDate: string,
  laNumber?: string,
): Promise<JobTimeEntry> {
  const client = getSupabaseServerClient();
  const now = new Date().toISOString();
  const { data, error } = await client
    .from("job_time_entries")
    .upsert(
      {
        google_event_id: googleEventId,
        editor_profile: editorProfile,
        work_date: workDate,
        la_number: laNumber ?? null,
        clock_in_at: now,
        clock_out_at: null,
        updated_at: now,
      },
      { onConflict: "google_event_id,editor_profile,work_date" },
    )
    .select()
    .single<JobTimeEntry>();

  if (error) throw new Error(`[job-time] clock-in failed: ${error.message}`);
  if (!data) throw new Error("[job-time] clock-in returned no row");
  return normalizeJobTimeEntry(data);
}

export async function upsertClockOut(
  googleEventId: string,
  editorProfile: string,
  workDate: string,
): Promise<JobTimeEntry | null> {
  const client = getSupabaseServerClient();
  const now = new Date().toISOString();
  const { data, error } = await client
    .from("job_time_entries")
    .update({ clock_out_at: now, updated_at: now })
    .eq("google_event_id", googleEventId)
    .eq("editor_profile", editorProfile)
    .eq("work_date", workDate)
    .not("clock_in_at", "is", null)
    .is("clock_out_at", null)
    .select()
    .maybeSingle<JobTimeEntry>();

  if (error) throw new Error(`[job-time] clock-out failed: ${error.message}`);
  return data ? normalizeJobTimeEntry(data) : null;
}

export async function deleteJobTimeEntry(
  googleEventId: string,
  editorProfile: string,
  workDate: string,
): Promise<void> {
  const client = getSupabaseServerClient();
  const { error } = await client
    .from("job_time_entries")
    .delete()
    .eq("google_event_id", googleEventId)
    .eq("editor_profile", editorProfile)
    .eq("work_date", workDate);

  if (error) throw new Error(`[job-time] clear failed: ${error.message}`);
}

export async function upsertEditTimes(
  googleEventId: string,
  editorProfile: string,
  workDate: string,
  clockInAt: string,
  clockOutAt: string | null,
): Promise<JobTimeEntry> {
  const client = getSupabaseServerClient();
  const now = new Date().toISOString();
  const { data, error } = await client
    .from("job_time_entries")
    .upsert(
      {
        google_event_id: googleEventId,
        editor_profile: editorProfile,
        work_date: workDate,
        clock_in_at: clockInAt,
        clock_out_at: clockOutAt,
        updated_at: now,
      },
      { onConflict: "google_event_id,editor_profile,work_date" },
    )
    .select()
    .single<JobTimeEntry>();

  if (error) throw new Error(`[job-time] edit-times failed: ${error.message}`);
  if (!data) throw new Error("[job-time] edit-times returned no row");
  return normalizeJobTimeEntry(data);
}
