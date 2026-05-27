import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import {
  authorizeEditorRequest,
  isSameOriginEditorMutation,
} from "@/lib/editor-auth";
import {
  upsertClockOut,
  upsertClockOutById,
  closeAllRemainingActiveEntries,
  getActiveJobTimeEntries,
  isJeffEditorId,
  normalizeEntryIdFromUnknown,
  normalizeEditorProfile,
  normalizeWorkDateFromUnknown,
} from "@/lib/job-time";
import { SupabaseConfigError } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { env } = getConfig();
  const auth = authorizeEditorRequest(req, env);

  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (auth.source === "cookie" && !isSameOriginEditorMutation(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!isJeffEditorId(auth.editorId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "missing_event_id" }, { status: 400 });
  }

  const { eventId, workDate, entryId } = body as Record<string, unknown>;
  const eventIdStr = typeof eventId === "string" ? eventId.trim() : "";
  const workDateStr = normalizeWorkDateFromUnknown(workDate);
  const entryIdStr = normalizeEntryIdFromUnknown(entryId);

  if (!eventIdStr) {
    return NextResponse.json({ error: "missing_event_id" }, { status: 400 });
  }
  if (!workDateStr) {
    return NextResponse.json({ error: "missing_work_date" }, { status: 400 });
  }

  console.log("[job-time:clock-out] receive", {
    entryId: entryIdStr,
    eventId: eventIdStr,
    workDate: workDateStr,
    editor: auth.editorId,
  });

  try {
    const editorProfile = normalizeEditorProfile(auth.editorId);
    let entry = null;

    if (entryIdStr) {
      entry = await upsertClockOutById(entryIdStr, editorProfile);
      if (!entry) {
        console.log("[job-time:clock-out] no active row found for entryId", {
          entryId: entryIdStr,
          eventId: eventIdStr,
          workDate: workDateStr,
        });
        return NextResponse.json(
          { error: "not_clocked_in", message: "No active clock-in found for this entry id." },
          { status: 404 },
        );
      }
    } else {
      entry = await upsertClockOut(eventIdStr, editorProfile, workDateStr);
    }

    if (!entry) {
      console.log("[job-time:clock-out] no active clock-in found for eventId:", eventIdStr, "workDate:", workDateStr);
      return NextResponse.json(
        { error: "not_clocked_in", message: "No active clock-in found for this job." },
        { status: 404 },
      );
    }
    console.log("[job-time:clock-out] updated", {
      id: entry.id,
      eventId: entry.google_event_id,
      workDate: entry.work_date,
      clock_out_at: entry.clock_out_at,
    });

    // Sweep any other active Jeff rows with the same clock_out_at timestamp.
    // Jeff can only have one active clock at a time; stale open rows are bugs.
    // Best-effort: a sweep failure does not roll back the primary clock-out.
    let swept = 0;
    try {
      swept = await closeAllRemainingActiveEntries(
        editorProfile,
        entry.clock_out_at!,
        entry.id,
      );
      if (swept > 0) {
        console.log("[job-time:clock-out] swept_orphaned_active_rows", { swept, primaryId: entry.id });
      }
    } catch (sweepErr) {
      console.error("[job-time:clock-out] sweep_failed", sweepErr instanceof Error ? sweepErr.message : sweepErr);
    }

    const activeAfterSweep = await getActiveJobTimeEntries(editorProfile);
    const activeCount = activeAfterSweep.length;
    const activeIds = activeAfterSweep.map((r) => r.id);
    console.log("[job-time:clock-out-server]", {
      closedId: entry.id,
      swept,
      activeCount,
      activeIds,
    });

    return NextResponse.json({ entry, activeCount, activeIds });
  } catch (error) {
    if (error instanceof SupabaseConfigError) {
      return NextResponse.json(
        { error: "unavailable", message: "Hours tracking unavailable." },
        { status: 503 },
      );
    }
    console.error("[job-time:clock-out]", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
