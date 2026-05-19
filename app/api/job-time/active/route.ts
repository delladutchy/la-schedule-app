import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import {
  getActiveJobTimeEntries,
  isJeffEditorId,
  normalizeEditorProfile,
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
    console.log(
      "[job-time:active] result:",
      entries.length,
      "entries |",
      entries.map((entry) => ({
        id: entry.id,
        eventId: entry.google_event_id,
        work_date: entry.work_date,
        clock_in_at: entry.clock_in_at,
      })),
    );
    return NextResponse.json(
      { entries },
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
