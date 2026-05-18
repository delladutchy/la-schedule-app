import "server-only";
import { getSupabaseServerClient, SupabaseConfigError } from "./supabase";

export type { SupabaseConfigError };

export interface JobTimeEntry {
  id: string;
  google_event_id: string;
  la_number: string | null;
  editor_profile: string;
  clock_in_at: string | null;
  clock_out_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** Normalize "legacy" token to canonical "jeff" profile in the DB. */
export function normalizeEditorProfile(editorId: string): string {
  return editorId === "legacy" ? "jeff" : editorId;
}

/** Only jeff (and legacy, normalized to jeff) may access time entries. */
export function isJeffEditorId(editorId: string): boolean {
  return editorId === "jeff" || editorId === "legacy";
}

export async function getJobTimeEntry(
  googleEventId: string,
  editorProfile: string,
): Promise<JobTimeEntry | null> {
  const client = getSupabaseServerClient();
  const { data, error } = await client
    .from("job_time_entries")
    .select("*")
    .eq("google_event_id", googleEventId)
    .eq("editor_profile", editorProfile)
    .maybeSingle<JobTimeEntry>();

  if (error) {
    if (error.code === "PGRST116") return null;
    throw new Error(`[job-time] read failed: ${error.message}`);
  }
  return data;
}

export async function upsertClockIn(
  googleEventId: string,
  editorProfile: string,
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
        la_number: laNumber ?? null,
        clock_in_at: now,
        clock_out_at: null,
        updated_at: now,
      },
      { onConflict: "google_event_id,editor_profile" },
    )
    .select()
    .single<JobTimeEntry>();

  if (error) throw new Error(`[job-time] clock-in failed: ${error.message}`);
  if (!data) throw new Error("[job-time] clock-in returned no row");
  return data;
}

export async function upsertClockOut(
  googleEventId: string,
  editorProfile: string,
): Promise<JobTimeEntry | null> {
  const client = getSupabaseServerClient();
  const now = new Date().toISOString();
  const { data, error } = await client
    .from("job_time_entries")
    .update({ clock_out_at: now, updated_at: now })
    .eq("google_event_id", googleEventId)
    .eq("editor_profile", editorProfile)
    .not("clock_in_at", "is", null)
    .is("clock_out_at", null)
    .select()
    .maybeSingle<JobTimeEntry>();

  if (error) throw new Error(`[job-time] clock-out failed: ${error.message}`);
  return data;
}
