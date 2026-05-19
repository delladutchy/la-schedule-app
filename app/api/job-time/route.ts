import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import { authorizeEditorRequest } from "@/lib/editor-auth";
import {
  getJobTimeEntries,
  isJeffEditorId,
  normalizeEditorProfile,
  normalizeWorkDate,
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

  const url = new URL(req.url);
  const eventId = url.searchParams.get("eventId")?.trim();
  if (!eventId) {
    return NextResponse.json({ error: "missing_event_id" }, { status: 400 });
  }
  const rawWorkDate = url.searchParams.get("workDate");
  const workDate = rawWorkDate ? normalizeWorkDate(rawWorkDate) : undefined;
  if (rawWorkDate && !workDate) {
    return NextResponse.json(
      { error: "invalid_work_date", message: "workDate must be YYYY-MM-DD." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  console.log("[job-time:get] eventId:", eventId, "workDate:", workDate ?? "all", "editor:", auth.editorId);

  try {
    const entries = await getJobTimeEntries(
      eventId,
      normalizeEditorProfile(auth.editorId),
      workDate ?? undefined,
    );
    console.log(
      "[job-time:get] result:", entries.length, "entries |",
      entries.map((e) => ({ id: e.id, work_date: e.work_date, clock_in_at: e.clock_in_at })),
    );
    return NextResponse.json({ entries }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof SupabaseConfigError) {
      return NextResponse.json(
        { error: "unavailable", message: "Hours tracking unavailable." },
        { status: 503 },
      );
    }
    console.error("[job-time:get]", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
