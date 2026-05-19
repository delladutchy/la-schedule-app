import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import {
  getActiveJobTimeEntries,
  isJeffEditorId,
  normalizeEditorProfile,
  resolveDeterministicActiveEntry,
} from "@/lib/job-time";
import { SupabaseConfigError } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(req, env);

  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isJeffEditorId(auth.editorId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const entries = await getActiveJobTimeEntries(normalizeEditorProfile(auth.editorId));
    const primaryEntry = resolveDeterministicActiveEntry(entries);
    if (entries.length > 1) {
      console.warn("[job-time:active] duplicate_active_rows_detected", {
        rowCount: entries.length,
        rows: entries.map((entry) => ({
          id: entry.id,
          eventId: entry.google_event_id,
          workDate: entry.work_date,
          clockInAt: entry.clock_in_at,
        })),
        selectedPrimaryId: primaryEntry?.id ?? null,
      });
    }
    console.log("[job-time:active] rows", {
      rowCount: entries.length,
      rows: entries.map((entry) => ({
        id: entry.id,
        eventId: entry.google_event_id,
        workDate: entry.work_date,
        clockInAt: entry.clock_in_at,
        clockOutAt: entry.clock_out_at,
      })),
      primaryId: primaryEntry?.id ?? null,
    });
    return NextResponse.json(
      { entries: primaryEntry ? [primaryEntry] : [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof SupabaseConfigError) {
      return NextResponse.json(
        { error: "unavailable", message: "Hours tracking unavailable." },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    console.error("[job-time:active]", error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: "internal_error" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
