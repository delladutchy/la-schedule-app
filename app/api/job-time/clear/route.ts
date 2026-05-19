import { NextResponse } from "next/server";
import { getConfig } from "@/lib/config";
import {
  authorizeEditorRequest,
  isSameOriginEditorMutation,
} from "@/lib/editor-auth";
import {
  deleteJobTimeEntry,
  deleteJobTimeEntryById,
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
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
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

  console.log("[job-time:clear] receive", {
    entryId: entryIdStr,
    eventId: eventIdStr,
    workDate: workDateStr,
    editor: auth.editorId,
  });

  try {
    const editorProfile = normalizeEditorProfile(auth.editorId);
    let cleared: Awaited<ReturnType<typeof deleteJobTimeEntry>> | null = null;

    if (entryIdStr) {
      cleared = await deleteJobTimeEntryById(entryIdStr, editorProfile);
      if (!cleared) {
        console.log("[job-time:clear] no row found for entryId", {
          entryId: entryIdStr,
          eventId: eventIdStr,
          workDate: workDateStr,
        });
        return NextResponse.json(
          { error: "not_found", message: "No entry found for this entry id." },
          { status: 404 },
        );
      }
    } else {
      cleared = await deleteJobTimeEntry(eventIdStr, editorProfile, workDateStr);
    }

    if (!cleared) {
      console.log("[job-time:clear] no row found for eventId/workDate", {
        eventId: eventIdStr,
        workDate: workDateStr,
      });
      return NextResponse.json(
        { error: "not_found", message: "No entry found for this job/date." },
        { status: 404 },
      );
    }

    console.log("[job-time:clear] cleared", {
      id: cleared.id,
      eventId: cleared.google_event_id,
      workDate: cleared.work_date,
    });
    return NextResponse.json({
      success: true,
      workDate: cleared.work_date,
      entryId: cleared.id,
      eventId: cleared.google_event_id,
    });
  } catch (error) {
    if (error instanceof SupabaseConfigError) {
      return NextResponse.json(
        { error: "unavailable", message: "Hours tracking unavailable." },
        { status: 503 },
      );
    }
    console.error("[job-time:clear]", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
